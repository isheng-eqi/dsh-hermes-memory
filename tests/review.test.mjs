import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runReview } from '../lib/review.js'
import { normalizeMemoryCall } from '../lib/core.js'
import { createMemoryToolDescription, createMemoryToolParameters } from '../lib/prompts.js'

const schema = name => ({ name, description: name, parameters: { type: 'object' } })
const config = { provider: 'captured-provider', model: 'captured-model', reasoningEffort: 'deep', maxTokens: 1024, temperature: 0.25, stop: ['END'] }
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Read-only synthetic evidence.' }] }]
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const text = value => ({ type: 'text', text: value })
const response = (blocks = [text('No additional durable facts.')], kind = 'stop', extra = {}) => [
  ...blocks.map((block, index) => ({ type: 'block-end', index, block })),
  { type: 'finish', reason: { kind }, ...extra },
]

function fakeLlm(scripts) {
  const preparations = [], requests = []
  let cursor = 0
  return {
    preparations, requests,
    async prepareCall(value, signal) {
      preparations.push({ config: structuredClone(value), signal })
      const captured = structuredClone(value)
      let used = false
      return {
        config: captured,
        stream(options) {
          assert.equal(used, false, 'each prepared call is single-use')
          used = true
          for (const [key, value] of Object.entries(captured)) assert.deepEqual(options[key], value, 'dispatch uses prepared config')
          requests.push(options)
          const script = scripts[cursor++]
          assert.ok(script, 'unexpected extra model call')
          if (typeof script === 'function') return script(options)
          return (async function* () { yield* script })()
        },
      }
    },
  }
}

const base = llm => ({ llm, config, messages, system: 'Review durable memory only.', tools: [schema('memory'), schema('memory_list')] })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

test('review retains captured route/controls, reads shared bank and saves only confirmed writes', async () => {
  const llm = fakeLlm([
    response([call('read-1', 'memory_list', { target: 'both' })], 'tool-calls'),
    response([call('save-1', 'memory', { action: 'add', content: 'synthetic approved fact' }), call('save-2', 'memory', { action: 'add', content: 'synthetic pending fact' })], 'tool-calls', { replayState: { response: { id: 'response-2' }, blocks: [{}, {}] } }),
    response([text('Review complete.')]),
  ])
  const inputs = freezeDeep({ config: structuredClone(config), messages: structuredClone(messages), tools: [schema('memory'), schema('memory_list')] })
  const before = JSON.stringify(inputs)
  const signal = new AbortController().signal
  const writes = [], reads = []
  const result = await runReview({
    ...base(llm), ...inputs, signal, sessionId: 'parent-session',
    executeMemory: async (args, context) => { writes.push({ args, context }); return writes.length === 1 ? { success: true, done: true } : { success: true, pending: true } },
    readMemory: async (args, context) => { reads.push({ args, context }); return { memory: [], user: [] } },
  })
  assert.deepEqual(result, { status: 'completed', iterations: 3, writes: 1, pending: 1, toolCalls: 3, text: 'Review complete.', truncated: false })
  assert.equal(JSON.stringify(inputs), before, 'review never mutates a supplied snapshot')
  assert.deepEqual(llm.preparations.map(item => item.config), [config, config, config])
  assert.equal(reads[0].context.background, true)
  assert.equal(reads[0].context.toolName, 'memory_list')
  assert.equal(writes[0].context.signal, signal)
  assert.equal(llm.requests[0].purpose, 'hermes-memory-review')
  assert.equal(llm.requests[0].sessionId, 'parent-session')
  assert.equal(llm.requests[0].system, 'Review durable memory only.')
  assert.deepEqual(llm.requests[0].tools.map(tool => tool.name), ['memory', 'memory_list'])
  const finalHistory = llm.requests[2].messages
  assert.deepEqual(finalHistory.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'tool'])
  const assistant = finalHistory[3]
  assert.equal(assistant.source.kind, 'model')
  assert.equal(assistant.source.provider, config.provider)
  assert.deepEqual(assistant.source.replayState.response, { id: 'response-2' })
  for (const message of finalHistory.filter(message => message.role === 'tool')) assert.equal(message.source.callId, message.toolCallId)
})

test('review accepts the current operations schema and delegates batch validation to the memory owner', async () => {
  const parameters = createMemoryToolParameters()
  const tools = [{ name: 'memory', description: createMemoryToolDescription(), parameters: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(parameters).map(([key, value]) => {
      const { required, ...schema } = value
      return [key, schema]
    })),
    required: Object.keys(parameters).filter(key => parameters[key].required), additionalProperties: false,
  } }]
  assert.deepEqual(tools[0].parameters.required, ['target', 'operations'])
  const args = { target: 'memory', operations: [{ action: 'add', content: 'Synthetic operations protocol fact.' }] }
  const llm = fakeLlm([response([call('standard-batch', 'memory', args)], 'tool-calls'), response()])
  const saved = []
  const result = await runReview({ ...base(llm), tools, executeMemory: async value => {
    const normalized = normalizeMemoryCall(value)
    if (!normalized.success) return normalized
    saved.push(normalized)
    return { success: true, done: true }
  } })
  assert.equal(result.status, 'completed')
  assert.equal(result.writes, 1)
  assert.deepEqual(saved, [{ success: true, target: 'memory', operations: [{ action: 'add', content: 'Synthetic operations protocol fact.' }] }])
})

test('authoritative block-end replaces deltas, preserves first-seen order and aggregates usage', async () => {
  const llm = fakeLlm([[
    { type: 'tool-call-delta', index: 4, id: 'save', name: 'memory', argumentsDelta: '{"action":"remove"' },
    { type: 'text-delta', index: 1, text: 'old' },
    { type: 'block-end', index: 4, block: call('save', 'memory', { action: 'add', content: 'synthetic fact' }) },
    { type: 'tool-call-delta', index: 4, id: 'save', argumentsDelta: 'bad straggler' },
    { type: 'block-end', index: 1, block: text('authoritative') },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: {}, blocks: [1] } },
  ], [
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]])
  const invoked = []
  const result = await runReview({ ...base(llm), tools: [schema('memory')], executeMemory: async args => { invoked.push(args); return { success: true } } })
  assert.equal(result.status, 'completed')
  assert.equal(result.writes, 1)
  assert.deepEqual(invoked, [{ action: 'add', content: 'synthetic fact' }])
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 })
  assert.equal(result.text, 'done')
  const assistant = llm.requests[1].messages[1]
  assert.deepEqual(assistant.content.map(block => block.type), ['tool-call', 'text'])
  assert.equal(assistant.source.replayState, undefined, 'mismatched replay block envelope is discarded')
})

test('only explicit memory tools execute; invalid calls become tool errors without arbitrary dispatch', async () => {
  const llm = fakeLlm([
    response([
      call('shell', 'pwsh', { command: 'Never execute' }),
      call('hidden', 'memory_list', {}),
      call('malformed', 'memory', '{bad json'),
      call('scalar', 'memory', 'null'),
      call('bad-action', 'memory', { action: 'execute' }),
    ], 'tool-calls'),
    response(),
  ])
  let executed = 0
  const result = await runReview({ ...base(llm), tools: [schema('memory')], executeMemory: async args => { executed++; return normalizeMemoryCall(args) } })
  assert.equal(result.status, 'completed')
  assert.equal(result.writes, 0)
  assert.equal(result.toolCalls, 5)
  assert.equal(executed, 1, 'memory owner validates business arguments after loop admits a JSON object')
  assert.equal(llm.requests[1].messages.filter(message => message.role === 'tool' && message.isError).length, 5)
  const invalid = await runReview({ ...base(llm), tools: [schema('pwsh')] })
  assert.equal(invalid.error.code, 'INVALID_REVIEW_TOOL')
  assert.equal(llm.preparations.length, 2, 'invalid whitelist cannot make a model request')
})

test('failed and pending writes are counted separately; callback errors can be repaired by the model', async () => {
  const llm = fakeLlm([
    response([call('a', 'memory', { action: 'add' }), call('b', 'memory', { action: 'add' }), call('c', 'memory', { action: 'add' })], 'tool-calls'),
    response(),
  ])
  let n = 0
  const result = await runReview({ ...base(llm), tools: [schema('memory')], executeMemory: async () => {
    n++
    if (n === 1) throw new Error('Synthetic disk failure')
    if (n === 2) return { success: false, error: 'capacity' }
    return { success: false, pending: true }
  } })
  assert.equal(result.status, 'completed')
  assert.equal(result.writes, 0)
  assert.equal(result.pending, 1)
  const results = llm.requests[1].messages.filter(message => message.role === 'tool')
  assert.equal(results[0].isError, true)
  assert.match(results[0].content[0].text, /Synthetic disk failure/)
  assert.equal(results[1].isError, true)
})

test('output truncation, provider failures and incomplete streams never dispatch their calls', async t => {
  const unsafe = call('unsafe', 'memory', { action: 'add', content: 'Do not save' })
  for (const [name, chunks, expected] of [
    ['max-tokens', response([unsafe], 'max-tokens'), 'REVIEW_MAX_TOKENS'],
    ['error', [{ type: 'block-end', index: 0, block: unsafe }, { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_LENGTH', message: 'Too much context' } } }], 'CONTEXT_LENGTH'],
    ['aborted', [{ type: 'block-end', index: 0, block: unsafe }, { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cancelled request' } } }], 'ABORTED'],
    ['missing-finish', [{ type: 'block-end', index: 0, block: unsafe }], 'INCOMPLETE_REVIEW_STREAM'],
  ]) await t.test(name, async () => {
    let writes = 0
    const result = await runReview({ ...base(fakeLlm([chunks])), tools: [schema('memory')], executeMemory: async () => { writes++; return { success: true } } })
    assert.equal(result.error.code, expected)
    assert.equal(result.status, name === 'aborted' ? 'aborted' : 'error')
    assert.equal(writes, 0)
  })
})

test('model stream cleanup finishes before a memory write starts', async () => {
  const closed = deferred(), release = deferred()
  let cleanupFinished = false, writes = 0
  const llm = fakeLlm([async function* () {
    try { yield* response([call('after-close', 'memory', { action: 'add' })], 'tool-calls') }
    finally { closed.resolve(); await release.promise; cleanupFinished = true }
  }, response()])
  const task = runReview({ ...base(llm), tools: [schema('memory')], executeMemory: async () => {
    assert.equal(cleanupFinished, true)
    writes++
    return { success: true }
  } })
  await closed.promise
  assert.equal(writes, 0)
  release.resolve()
  assert.equal((await task).status, 'completed')
  assert.equal(writes, 1)
})

test('duplicate model call ids fail before side effects', async () => {
  const llm = fakeLlm([response([call('same', 'memory', { action: 'add' }), call('same', 'memory', { action: 'add' })], 'tool-calls')])
  let saved = 0
  const result = await runReview({ ...base(llm), tools: [schema('memory')], executeMemory: async () => { saved++; return { success: true } } })
  assert.equal(result.error.code, 'INVALID_REVIEW_STREAM')
  assert.equal(saved, 0)
})

test('default 16-request limit stops persistent tool loops', async () => {
  const llm = fakeLlm(Array.from({ length: 16 }, (_, index) => response([call(`read-${index}`, 'memory_list', {})], 'tool-calls')))
  const result = await runReview({ ...base(llm), tools: [schema('memory_list')], readMemory: async () => ({ memory: [] }) })
  assert.equal(result.status, 'max-iterations')
  assert.equal(result.iterations, 16)
  assert.equal(result.toolCalls, 16)
  assert.equal(llm.preparations.length, 16)
})

test('input cap rejects evidence intact and never silently truncates', async () => {
  const llm = fakeLlm([response()])
  const original = structuredClone(messages)
  const result = await runReview({ ...base(llm), tools: [], maxInputChars: 20 })
  assert.equal(result.error.code, 'REVIEW_INPUT_TOO_LARGE')
  assert.equal(result.truncated, false)
  assert.deepEqual(messages, original)
  assert.equal(llm.preparations.length, 0)
  const unbounded = await runReview({ ...base(llm), tools: [], messages: [{ role: 'user', content: [text('a'.repeat(150_000))] }] })
  assert.equal(unbounded.status, 'completed')
  assert.equal(llm.requests[0].messages[0].content[0].text.length, 150_000)
})

test('caller cancellation stops metadata preparation and stream waiting', async t => {
  await t.test('already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('unloaded'))
    let prepared = false
    const result = await runReview({ ...base({ prepareCall: async () => { prepared = true } }), signal: controller.signal, tools: [] })
    assert.equal(result.status, 'aborted')
    assert.equal(prepared, false)
  })
  await t.test('metadata', async () => {
    const controller = new AbortController(), started = deferred()
    const task = runReview({ ...base({ prepareCall: () => { started.resolve(); return new Promise(() => {}) } }), tools: [], signal: controller.signal })
    await started.promise
    controller.abort(new Error('plugin unloaded'))
    const result = await task
    assert.equal(result.status, 'aborted')
    assert.match(result.error.message, /plugin unloaded/)
    assert.equal(result.iterations, 0)
  })
  await t.test('stream', async () => {
    const controller = new AbortController(), started = deferred()
    let returned = false
    const llm = fakeLlm([() => ({
      [Symbol.asyncIterator]() { return this },
      next() { started.resolve(); return new Promise(() => {}) },
      return() { returned = true; return Promise.resolve({ done: true }) },
    })])
    const task = runReview({ ...base(llm), tools: [], signal: controller.signal })
    await started.promise
    controller.abort(new Error('deadline'))
    const result = await task
    assert.equal(result.status, 'aborted')
    assert.equal(returned, true)
  })
})

test('cancellation drains a started write, reports its commit and starts no later calls', async () => {
  const controller = new AbortController(), started = deferred(), release = deferred()
  const llm = fakeLlm([response([call('first', 'memory', { action: 'add' }), call('later', 'memory', { action: 'add' })], 'tool-calls')])
  let invoked = 0, settled = false
  const task = runReview({ ...base(llm), tools: [schema('memory')], signal: controller.signal, executeMemory: async () => {
    invoked++
    started.resolve()
    await release.promise
    return { success: true }
  } }).then(value => { settled = true; return value })
  await started.promise
  controller.abort(new Error('unloaded during commit'))
  await Promise.resolve()
  assert.equal(settled, false, 'started commit remains owned until it settles')
  release.resolve()
  const result = await task
  assert.equal(result.status, 'aborted')
  assert.equal(result.writes, 1)
  assert.equal(invoked, 1)
  assert.equal(result.toolCalls, 1)
})

test('read-only callback cancellation cannot initiate subsequent writes', async () => {
  const controller = new AbortController(), started = deferred()
  const llm = fakeLlm([response([call('read', 'memory_list', {}), call('save', 'memory', { action: 'add' })], 'tool-calls')])
  let saved = 0
  const task = runReview({ ...base(llm), signal: controller.signal, readMemory: async () => { started.resolve(); await new Promise(() => {}) }, executeMemory: async () => { saved++; return { success: true } } })
  await started.promise
  controller.abort(new Error('cancel read'))
  assert.equal((await task).status, 'aborted')
  assert.equal(saved, 0)
})

test('current DSH llm.prepareCall with a fake adapter executes an isolated two-request review', { skip: !process.env.DSH_CLIENT_TEST_CHECKOUT }, async t => {
  const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT
  const require = createRequire(join(checkout, 'packages/llm/llm/package.json'))
  const { Context } = require('@deepseek-ai/cordis')
  const { default: LlmRuntime, LlmAdapter } = await import(pathToFileURL(join(checkout, 'packages/llm/llm/lib/index.js')))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  const requests = []
  class LocalAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'deep', name: 'Deep' }], defaultEffort: 'deep' } }
    }
    async *stream(options) {
      requests.push(options)
      if (requests.length === 1) yield* response([call('real-host-save', 'memory', { action: 'add', content: 'in-memory fixture only' })], 'tool-calls', { replayState: { response: { fake: true }, blocks: [null] } })
      else yield* response([text('Saved by fake adapter.')])
    }
  }
  ctx.llm.registerAdapter([config.provider], new LocalAdapter())
  const saved = []
  const result = await runReview({ ...base(ctx.llm), tools: [schema('memory')], config: { ...config, maxTokens: 256 }, sessionId: 'review-fixture-parent', executeMemory: async args => { saved.push(args); return { success: true } } })
  assert.equal(result.status, 'completed', JSON.stringify(result.error))
  assert.equal(result.writes, 1)
  assert.equal(result.iterations, 2)
  assert.equal(saved.length, 1)
  assert.equal(requests[0].purpose, 'hermes-memory-review')
  assert.equal(requests[0].sessionId, 'review-fixture-parent')
  assert.equal(requests[0].maxTokens, 256)
  assert.equal(requests[0].reasoningEffort, 'deep')
  assert.deepEqual(requests[1].messages.map(message => message.role), ['user', 'assistant', 'tool'])
  assert.equal(requests[1].messages[1].source.kind, 'model')
  assert.equal(requests[1].messages[2].source.kind, 'tool')
  const defaulted = await runReview({ ...base(ctx.llm), tools: [], config: { provider: config.provider, model: config.model } })
  assert.equal(defaulted.status, 'completed')
  assert.equal(requests[2].maxTokens, 4096, 'dispatch uses adapter-materialized prepared config')
  assert.equal(requests[2].reasoningEffort, 'deep')
})
