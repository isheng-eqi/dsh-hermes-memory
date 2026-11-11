import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import plugin from '../lib/index.js'

const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT
const textOf = messages => messages.flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')

for (const mode of ['static', 'dynamic']) for (const compression of ['none', 'zstd']) {
  test(`${mode}/${compression}: real v4 persistence, reopen and frozen snapshot survive a complete turn`, { skip: !checkout }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-v4-'))
    const require = createRequire(join(checkout, 'packages/core/session/package.json'))
    const { Context } = require('@deepseek-ai/cordis')
    const timerRequire = createRequire(join(checkout, 'packages/extensions/cordis-host-runner/package.json'))
    const Timer = timerRequire('@deepseek-ai/cordis-plugin-timer').default
    const load = path => import(pathToFileURL(join(checkout, path)))
    const { default: Sessions, Session } = await load('packages/core/session/lib/index.js')
    const { default: Projections } = await load('packages/session/session-projection/lib/index.js')
    const { default: Storage } = await load('packages/storage/storage/lib/index.js')
    const JsonStorage = await load('packages/storage/storage-json/lib/index.js')
    const Jsonl = await load('packages/session/session-persistence-jsonl/lib/index.js')
    const contexts = []
    t.after(async () => {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      assert.ok(root.startsWith(join(tmpdir(), 'hermes-v4-')), 'only the exact temporary fixture may be removed')
      await rm(root, { recursive: true, force: true })
    })
    async function mount() {
      const ctx = new Context(), tools = new Map()
      contexts.push(ctx)
      await ctx.plugin(Timer)
      await ctx.plugin(Sessions)
      await ctx.plugin(Projections)
      await ctx.plugin(Storage)
      await ctx.plugin(JsonStorage, { root: join(root, 'storages') })
      await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression })
      ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
      ctx.provide('webServer', { register: () => () => {} })
      let owner
      if (mode === 'static') owner = await ctx.plugin(plugin, { backgroundReview: { enabled: false } })
      else {
        const { createSandbox, evaluateHostCode } = await load('packages/extensions/cordis-host-runner/lib/types/sandbox.js')
        const { guardedPlugin } = await load('packages/extensions/cordis-host-runner/lib/types/guard.js')
        const source = await readFile(new URL('../host.js', import.meta.url), 'utf8')
        const dynamic = await evaluateHostCode(createSandbox('hermes-wire', { handle: () => () => {} }), source, 'hermes-wire', 5000)
        owner = await ctx.plugin(guardedPlugin(dynamic, error => { throw error }))
      }
      return { ctx, tools, owner }
    }
    const first = await mount()
    const session = first.ctx.sessions.create('hermes-wire-' + mode + '-' + compression)
    const writer = await first.ctx.sessionPersistence.create(session.header)
    const signal = new AbortController().signal
    const exec = { agent: { session }, signal }
    const memory = first.tools.get('memory')
    assert.equal((await memory.execute({ target: 'memory', operations: [{ action: 'add', content: 'Synthetic wire fixture uses a local test directory.' }] }, exec)).success, true)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: 'wire-user-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Synthetic fixture conversation.' }],
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    const before = { kind: 'enter', startsRequestSeries: true, messages: [] }
    const decision = await first.ctx.waterfall('agent/pre-step', { ...exec, turn: 1, step: 1 }, async () => before)
    assert.equal(decision.startsRequestSeries, true)
    assert.match(textOf(decision.messages), /Synthetic wire fixture/)
    for (const message of decision.messages) {
      assert.match(message.source.kind, /^plugin:/)
      assert.notEqual(message.source.kind, 'plugin')
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'wire-assistant-1', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Synthetic final response.' }] },
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal(await first.ctx.sessions.flush(session), true, 'real JSONL barrier must encode and publish every plugin message')
    const storedStat = await first.ctx.sessionPersistence.stat(session.id)
    assert.equal(storedStat.header.version, 4)
    assert.ok(storedStat.sizeBytes > 0)
    const persistedBytes = await readFile(storedStat.location.path)
    assert.ok(persistedBytes.length > 0)
    const reader = await first.ctx.sessionPersistence.open(session.id, 'read')
    const stored = await reader.read()
    await reader.close()
    assert.equal(stored.events.at(-1).type, 'turn/end')
    assert.equal(stored.events.filter(event => event.type === 'user/message' && event.data.source.kind.startsWith('plugin:')).length, decision.messages.length)
    const beforeMessages = session.deriveMessages()
    const checkpoint = first.ctx.sessionProjections.checkpoint(session)
    await writer.close()
    await first.owner.dispose()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount()
    const reopened = await second.ctx.sessionPersistence.open(session.id, 'read')
    const restoredLog = await reopened.read()
    await reopened.close()
    assert.deepEqual(restoredLog.events, stored.events)
    const restored = Session.fromRestore(session.id, restoredLog.events, reopened.header, reopened.inheritedEventCount, restoredLog.eventState)
    second.ctx.sessions.enter(restored)
    second.ctx.sessions.announce(restored)
    assert.deepEqual(restored.deriveMessages(), beforeMessages)
    const restoredCheckpoint = second.ctx.sessionProjections.checkpoint(restored).hermesMemory
    assert.equal(restoredCheckpoint.ver, checkpoint.hermesMemory.ver)
    assert.deepEqual(restoredCheckpoint.val, checkpoint.hermesMemory.val)
    const next = await second.ctx.waterfall('agent/pre-step', { agent: { session: restored }, signal, turn: 2, step: 1 }, async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] }))
    assert.equal(next.messages.filter(message => textOf([message]).includes('<hermes-memory>')).length, 0, 'reopen must not duplicate the frozen snapshot')
    const fresh = second.ctx.sessions.create('fresh-wire-' + mode + '-' + compression)
    const freshDecision = await second.ctx.waterfall('agent/pre-step', { agent: { session: fresh }, signal, turn: 1, step: 1 }, async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] }))
    assert.match(textOf(freshDecision.messages), /Synthetic wire fixture/)
    const actualStore = JSON.parse(await readFile(join(root, 'storages', 'hermes_memory.json'), 'utf8'))
    assert.equal(actualStore.global.format, 2)
    assert.equal(Object.values(actualStore.global.tables.memory).length, 1)
  })
}
