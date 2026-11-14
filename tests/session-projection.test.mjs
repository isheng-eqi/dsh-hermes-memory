import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import staticPlugin from '../lib/index.js'
import { canonicalMemory } from './host-fixture.mjs'

const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT
const tick = () => new Promise(resolve => setImmediate(resolve))
const marked = (decision, marker) => decision.messages.filter(message => message.content.some(block => block.type === 'text' && block.text.includes(marker)))

for (const mode of ['static', 'dynamic']) {
  test(`${mode}: real current DSH Session and registry preserve frozen memory, durable counters and restore/seed/fork`, { skip: !checkout }, async t => {
    const require = createRequire(join(checkout, 'packages/core/session/package.json'))
    const { Context } = require('@deepseek-ai/cordis')
    const load = relative => import(pathToFileURL(join(checkout, relative)))
    const { default: SessionStore, Session } = await load('packages/core/session/lib/index.js')
    const { default: Projections } = await load('packages/session/session-projection/lib/index.js')
    const ctx = new Context()
    t.after(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    await ctx.plugin(Projections)
    const tools = new Map(), logs = new WeakMap()
    ctx.on('session/event', (session, event) => {
      let log = logs.get(session)
      if (!log) logs.set(session, log = [])
      log.push(structuredClone(event))
    })
    ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
    await ctx.plugin((await load('vendor/timer/lib/index.js')).default)
    ctx.provide('webServer', { register: () => () => {} })
    let releaseOpen, storageFailure = null
    const openGate = new Promise(resolve => { releaseOpen = resolve })
    let saved = { global: null, tables: { memory: {}, user: {} } }
    let runtimeSaved = { global: null, tables: {} }
    ctx.provide('storage', { backend: { get: () => ({ kv: {
      async open(descriptor) {
        await openGate
        const isRuntime = descriptor.name === 'hermes_memory_runtime'
        return {
          loadAll: async () => structuredClone(isRuntime ? runtimeSaved : saved),
          async setGlobal(global) { if (storageFailure) throw storageFailure; if (isRuntime) runtimeSaved.global = structuredClone(global); else saved.global = structuredClone(global) },
          async close() {},
        }
      },
    } }) } })
    async function mount() {
      if (mode === 'static') return await ctx.plugin(staticPlugin, {})
      const { createSandbox, evaluateHostCode } = await load('packages/extensions/cordis-host-runner/lib/types/sandbox.js')
      const { guardedPlugin } = await load('packages/extensions/cordis-host-runner/lib/types/guard.js')
      const source = await readFile(new URL('../host.js', import.meta.url), 'utf8')
      const plugin = await evaluateHostCode(createSandbox('hermes-test', { handle: () => () => {} }), source, 'hermes-test', 5000)
      return await ctx.plugin(guardedPlugin(plugin, error => { throw error }))
    }
    let owner = await mount()
    const session = ctx.sessions.create('hermes-regression')
    assert.equal('events' in session, false, 'the real current Session must not expose events')
    const signal = new AbortController().signal
    const pre = (target, turn, step = 1, decision = { kind: 'enter', messages: [], startsRequestSeries: true }) => ctx.waterfall('agent/pre-step', { agent: { session: target }, turn, step, signal }, async () => decision)
    const admit = (target, decision) => {
      for (const message of decision.messages) target.append('user/message', message, { surfaceOp: 'append' })
    }
    let callIndex = 0
    async function memory(target, args) {
      args = canonicalMemory(args)
      const callId = 'memory-' + ++callIndex
      const call = target.append('tool/call', { turn: 1, step: 1, callId, name: 'memory', arguments: JSON.stringify(args) })
      const tool = tools.get('memory')
      try {
        const value = await tool.execute(args, { agent: { session: target }, signal })
        const content = tool.output.render(args, value)
        target.append('tool/result', { turn: 1, step: 1, message: { id: 'result-' + callId, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        return value
      } catch (error) {
        target.append('tool/result', { turn: 1, step: 1, message: { id: 'result-' + callId, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError: true, content: [{ type: 'text', text: String(error) }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        throw error
      }
    }
    session.append('turn/start', { turn: 1 })
    let settled = false
    const pending = pre(session, 1).then(value => { settled = true; return value })
    await tick()
    assert.equal(settled, false, 'first step waits for cold storage')
    releaseOpen()
    const first = await pending
    assert.equal(first.startsRequestSeries, true)
    assert.equal(marked(first, '<hermes-memory-snapshot>').length, 1)
    assert.match(first.messages[0].content[0].text, /Both persistent memory banks are empty/)
    admit(session, first)
    assert.equal((await memory(session, { action: 'add', content: 'synthetic durable fact' })).success, true)
    const afterWrite = ctx.sessionProjections.checkpoint(session).hermesMemory.val
    assert.equal(afterWrite.userTurnCount, 0)
    assert.equal(afterWrite.hasSnapshot, true)
    for (let turn = 2; turn <= 11; turn++) {
      session.append('turn/start', { turn })
      const decision = await pre(session, turn)
      assert.equal(marked(decision, '<hermes-memory-snapshot>').length, 0, 'empty freeze remains frozen after writes')
      assert.equal(marked(decision, '<hermes-memory-nudge>').length, 0)
      assert.equal((await pre(session, turn, 2)).messages.length, 0, 'same-step/turn reminder is deduplicated')
      admit(session, decision)
    }
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    assert.equal(checkpoint.hermesMemory.val.userTurnCount, 0)
    const events = logs.get(session)
    const cut = structuredClone(checkpoint)
    const floor = ctx.sessionProjections.restoreFloor(cut)
    const restoredState = ctx.sessionProjections.restore(cut, events.slice(floor), floor, session.header, session.inheritedEventCount)
    assert.deepEqual(structuredClone(restoredState.checkpoint.hermesMemory.val), cut.hermesMemory.val, 'parse adapter works across real checkpoint/restore')
    cut.hermesMemory.val.turnCount = 'invalid'
    assert.throws(() => ctx.sessionProjections.restore(cut, events, 0, session.header, session.inheritedEventCount), /Invalid hermesMemory projection state/)

    // Reload the plugin to prove the reminder baseline comes from events, not maps.
    await owner.dispose()
    assert.deepEqual(ctx.sessionProjections.checkpoint(session), {})
    owner = await mount()
    const restored = Session.fromRestore(session.id, structuredClone(events), structuredClone(session.header), 0, 'detached')
    ctx.sessionProjections.hydrate(restored, checkpoint, events, 0)
    assert.equal((await pre(restored, 11, 2)).messages.length, 0)
    for (let turn = 12; turn <= 20; turn++) {
      restored.append('turn/start', { turn })
      assert.equal((await pre(restored, turn)).messages.length, 0)
    }
    storageFailure = new Error('synthetic disk full')
    await assert.rejects(memory(restored, { action: 'add', content: 'failed synthetic write' }), /synthetic disk full/)
    assert.equal(ctx.sessionProjections.checkpoint(restored).hermesMemory.val.userTurnCount, 0)
    restored.append('turn/start', { turn: 21 })
    assert.equal(marked(await pre(restored, 21), '<hermes-memory-nudge>').length, 0)
    storageFailure = null
    // Every rejected durable write has an uncertain outcome until a fresh open.
    await owner.dispose()
    owner = await mount()

    const seed = ctx.sessions.create('seeded-regression', { seed: events })
    const fork = ctx.sessions.fork(session, undefined, 'forked-regression')
    for (const inherited of [seed, fork]) {
      assert.equal('events' in inherited, false)
      assert.equal((await pre(inherited, 11)).messages.length, 0, 'seed/fork retains admitted snapshot and nudge')
      assert.equal(ctx.sessionProjections.checkpoint(inherited).hermesMemory.val.userTurnCount, 0)
    }
    const ptc = ctx.sessions.create('ptc-regression')
    admit(ptc, await pre(ptc, 1))
    ptc.append('turn/start', { turn: 1 })
    const ptcArgs = canonicalMemory({ action: 'add', content: 'synthetic PTC fact' })
    ptc.append('tool/ptc-dispatch-start', { rootCallId: 'ptc-root', parentCallId: 'ptc-root', subCallId: 'ptc-save', name: 'memory', arguments: ptcArgs })
    const memoryTool = tools.get('memory')
    const ptcValue = await memoryTool.execute(ptcArgs, { agent: { session: ptc }, signal })
    const ptcContent = memoryTool.output.render(ptcArgs, ptcValue)
    ptc.append('tool/ptc-dispatch', { rootCallId: 'ptc-root', parentCallId: 'ptc-root', subCallId: 'ptc-save', name: 'memory', arguments: ptcArgs, isError: false, content: ptcContent })
    const ptcCheckpoint = ctx.sessionProjections.checkpoint(ptc)
    assert.equal(ptcCheckpoint.hermesMemory.val.userTurnCount, 0)
    const ptcEvents = structuredClone(logs.get(ptc))
    await owner.dispose()
    owner = await mount()
    const ptcRestored = Session.fromRestore(ptc.id, structuredClone(ptcEvents), structuredClone(ptc.header), 0, 'detached')
    ctx.sessionProjections.hydrate(ptcRestored, ptcCheckpoint, ptcEvents, 0)
    for (let turn = 2; turn <= 10; turn++) {
      ptcRestored.append('turn/start', { turn })
      assert.equal((await pre(ptcRestored, turn)).messages.length, 0, 'PTC write still delays reminders after reload/restore')
    }
    const failedPtc = { rootCallId: 'ptc-root', parentCallId: 'ptc-root', subCallId: 'ptc-failed', name: 'memory', arguments: {}, isError: true, content: ptcContent }
    ptcRestored.append('tool/ptc-dispatch', failedPtc)
    ptcRestored.append('tool/ptc-dispatch', { ...failedPtc, subCallId: 'ptc-business-error', isError: false, content: [{ type: 'text', text: 'memory: entry not found' }] })
    assert.equal(ctx.sessionProjections.checkpoint(ptcRestored).hermesMemory.val.userTurnCount, 0)
    ptcRestored.append('turn/start', { turn: 11 })
    assert.equal(marked(await pre(ptcRestored, 11), '<hermes-memory-nudge>').length, 0)
    for (const inherited of [ctx.sessions.create('ptc-seed', { seed: ptcEvents }), ctx.sessions.fork(ptc, undefined, 'ptc-fork')]) {
      assert.equal(ctx.sessionProjections.checkpoint(inherited).hermesMemory.val.userTurnCount, 0)
    }
    const fresh = ctx.sessions.create('fresh-regression')
    const freshDecision = await pre(fresh, 1)
    assert.match(freshDecision.messages[0].content[0].text, /synthetic durable fact/)
    await owner.dispose()
    assert.deepEqual(ctx.sessionProjections.checkpoint(fresh), {})
  })
}
