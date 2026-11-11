import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import plugin from '../lib/index.js'

const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT
const textOf = messages => messages.flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')

test('real host: ten durable turns -> isolated LLM -> JSON commit -> reopen -> fresh-session injection', { skip: !checkout }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-background-e2e-'))
  const require = createRequire(join(checkout, 'packages/extensions/cordis-host-runner/package.json'))
  const { Context } = require('@deepseek-ai/cordis')
  const Timer = require('@deepseek-ai/cordis-plugin-timer').default
  const load = path => import(pathToFileURL(join(checkout, path)))
  const { default: Sessions, Session } = await load('packages/core/session/lib/index.js')
  const { default: Projections } = await load('packages/session/session-projection/lib/index.js')
  const { default: Storage } = await load('packages/storage/storage/lib/index.js')
  const JsonStorage = await load('packages/storage/storage-json/lib/index.js')
  const Jsonl = await load('packages/session/session-persistence-jsonl/lib/index.js')
  const { default: LlmRuntime, LlmAdapter } = await load('packages/llm/llm/lib/index.js')
  const contexts = [], requests = []
  const fact = 'Synthetic e2e fixture uses Node 24 across all its test sessions.'
  class ReviewAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 1024 } }
    async *stream(options) {
      requests.push(options)
      const block = requests.length === 1
        ? { type: 'tool-call', id: 'e2e-memory-save', name: 'memory', arguments: JSON.stringify({ target: 'memory', operations: [{ action: 'add', content: fact }] }) }
        : { type: 'text', text: 'Saved the supported synthetic fact.' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: requests.length === 1 ? 'tool-calls' : 'stop' } }
    }
  }
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    assert.ok(root.startsWith(join(tmpdir(), 'hermes-background-e2e-')), 'only this temporary fixture may be removed')
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
    await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['synthetic-e2e'], new ReviewAdapter())
    ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
    ctx.provide('webServer', { register: () => () => {} })
    await ctx.plugin(plugin, {})
    return { ctx, tools }
  }
  const first = await mount()
  const session = first.ctx.sessions.create('hermes-background-e2e')
  const writer = await first.ctx.sessionPersistence.create(session.header)
  const signal = new AbortController().signal
  for (let turn = 1; turn <= 10; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', { id: 'e2e-user-' + turn, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: turn === 10 ? 'Synthetic stable environment: Node 24 is used across our fixture sessions.' : 'Synthetic fixture turn ' + turn }] }, { surfaceOp: 'append' })
    const decision = await first.ctx.waterfall('agent/pre-step', { agent: { session }, signal, turn, step: 1 }, async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] }))
    session.append('step/start', { turn, step: 1 })
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    if (turn === 1) session.append('request/header', { reason: 'initial', header: { config: { provider: 'synthetic-e2e', model: 'fixture' } } })
    session.append('assistant/message', { turn, step: 1, stream: [], message: { id: 'e2e-assistant-' + turn, role: 'assistant', source: { kind: 'model', provider: 'synthetic-e2e', model: 'fixture' }, content: [{ type: 'text', text: 'Synthetic final response.' }] } }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    assert.equal(await first.ctx.sessions.flush(session), true)
    if (turn < 10) assert.equal(requests.length, 0)
  }
  let debug
  const deadline = Date.now() + 5000
  do {
    debug = await first.tools.get('memory_debug').execute({}, { signal })
    if (debug.backgroundReview.status === 'completed' && debug.backgroundReview.active === 0) break
    await delay(5)
  } while (Date.now() < deadline)
  assert.equal(debug.backgroundReview.status, 'completed', JSON.stringify(debug))
  assert.equal(debug.backgroundReview.active, 0)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].purpose, 'hermes-memory-review')
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['memory', 'memory_list'])
  assert.deepEqual(requests[0].tools[0].parameters.properties.operations.items.required, ['action'])
  assert.match(requests[0].messages[0].content[0].text, /Synthetic stable environment/)
  const memory = JSON.parse(await readFile(join(root, 'storages/hermes_memory.json'), 'utf8'))
  assert.deepEqual(Object.values(memory.global.tables.memory).map(record => record.text), [fact])
  const runtime = JSON.parse(await readFile(join(root, 'storages/hermes_memory_runtime.json'), 'utf8'))
  const review = runtime.global.reviews['session:' + session.id]
  assert.equal(review.status, 'completed')
  assert.equal(review.writes, 1)
  assert.equal(review.provenance.durable, true)
  assert.equal(review.provenance.userTurnCount, 10)
  const originalMessages = session.deriveMessages()
  assert.equal(originalMessages.filter(message => message.source?.kind === 'plugin:dsh-hermes-memory').length, 1)
  assert.doesNotMatch(textOf(originalMessages.filter(message => message.source?.kind === 'plugin:dsh-hermes-memory')), /Synthetic e2e fixture uses Node 24/)
  await writer.close()
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)

  const second = await mount()
  const reader = await second.ctx.sessionPersistence.open(session.id, 'read')
  const log = await reader.read()
  await reader.close()
  const restored = Session.fromRestore(session.id, log.events, reader.header, reader.inheritedEventCount, log.eventState)
  second.ctx.sessions.enter(restored)
  second.ctx.sessions.announce(restored)
  assert.deepEqual(restored.deriveMessages(), originalMessages, 'review never polluted the main-session transcript')
  const frozen = await second.ctx.waterfall('agent/pre-step', { agent: { session: restored }, signal, turn: 11, step: 1 }, async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] }))
  assert.equal(frozen.messages.length, 0, 'restored session keeps its original frozen snapshot')
  const fresh = second.ctx.sessions.create('hermes-background-e2e-fresh')
  const snapshot = await second.ctx.waterfall('agent/pre-step', { agent: { session: fresh }, signal, turn: 1, step: 1 }, async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] }))
  assert.ok(textOf(snapshot.messages).includes(fact), 'new session reads the durable background update')
  assert.equal(requests.length, 2, 'restore does not spend another model request')
})
