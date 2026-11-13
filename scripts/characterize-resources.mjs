/** Offline component characterization. Never opens a user profile or calls a model. */
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { apply } from '../lib/index.js'
import { projectionFixture, timers } from '../tests/host-fixture.mjs'

const MAX_REVIEW_EVIDENCE_UTF16_UNITS = 2000000
const evidenceUnits = (sessions, rounds, perTurn) => sessions * rounds * (rounds + 1) / 2 * perTurn
const totalEvidenceUnits = options => options.evidenceChars + evidenceUnits(options.sessions, options.rounds, options.evidenceChars) + options.sessions * options.evidenceChars

export function optionsFrom(args) {
  const options = { sessions: 8, rounds: 3, evidenceChars: 4096 }
  for (const arg of args) {
    const match = /^--(sessions|rounds|evidenceChars)=(\d+)$/.exec(arg)
    if (!match) throw new Error('Expected --sessions=N, --rounds=N or --evidenceChars=N')
    options[match[1]] = Number(match[2])
  }
  const limits = { sessions: 32, rounds: 20, evidenceChars: 16384 }
  for (const [key, max] of Object.entries(limits)) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`${key} must be an integer from 1 to ${max}`)
  }
  if (totalEvidenceUnits(options) > MAX_REVIEW_EVIDENCE_UTF16_UNITS) {
    throw new Error('Synthetic review user evidence exceeds 2,000,000 UTF-16 code units, including history replay and all phases')
  }
  return options
}

function waitForRelease(gate, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    gate.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
  })
}

async function* syntheticStream() {
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No durable fact in this synthetic load.' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

// Stream injection is local to this offline harness; no production runtime hooks.
export async function characterize(options = optionsFrom([]), { streamFactory = syntheticStream, reviewTimeoutMs = 120000 } = {}) {
  options = optionsFrom(Object.entries(options).map(([key, value]) => `--${key}=${value}`))
  if (typeof streamFactory !== 'function' || !Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 120000) {
    throw new Error('Invalid synthetic stream factory or review timeout')
  }
  const phases = []
  for (const [name, sessions, rounds] of [['baseline', 1, 1], ['concurrent', options.sessions, options.rounds], ['disposal', options.sessions, 1]]) {
    const started = performance.now(), before = process.memoryUsage()
    const sampledHighWater = { heapUsed: before.heapUsed, rss: before.rss }
    const sample = () => { const m = process.memoryUsage(); for (const key of Object.keys(sampledHighWater)) sampledHighWater[key] = Math.max(sampledHighWater[key], m[key]) }
    const snapshots = new Map(), events = new Map(), tools = new Map(), disposers = []
    const projections = projectionFixture(), reviewOutcomes = {}
    let requests = 0, storageWrites = 0, closedUnits = 0, openedUnits = 0, activeStreams = 0, finishedStreams = 0, abortedRequests = 0, messageInputUtf16Units = 0
    let release
    let gate = new Promise(resolve => { release = resolve })
    const backend = { kv: { async open(descriptor) {
      openedUnits++
      if (!snapshots.has(descriptor.name)) snapshots.set(descriptor.name, { global: null, tables: descriptor.name === 'hermes_memory' ? { memory: {}, user: {} } : {} })
      let closed = false
      const ensureOpen = () => { if (closed) throw new Error(`Storage unit ${descriptor.name} is closed`) }
      return {
        async loadAll() { ensureOpen(); return structuredClone(snapshots.get(descriptor.name)) },
        async setGlobal(global) { ensureOpen(); storageWrites++; snapshots.get(descriptor.name).global = structuredClone(global); sample() },
        async close() { ensureOpen(); closed = true; closedUnits++ },
      }
    } } }
    const llm = { async prepareCall(config, signal) { return { config, async *stream(input) {
      requests++; activeStreams++; messageInputUtf16Units += JSON.stringify(input.messages).length; sample()
      try {
        await waitForRelease(gate, signal)
        yield* streamFactory({ config, input, signal })
      } finally { activeStreams--; finishedStreams++; if (signal.aborted) abortedRequests++ }
    } } } }
    const services = { storage: { backend: { get: () => backend } }, sessions: { flush: async () => true }, llm }
    const ctx = { ...timers, sessionProjections: projections.service,
      get: key => services[key],
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
      on(event, handler) { events.set(event, handler); const off = () => events.delete(event); disposers.push(off); return off },
    }
    let disposal, maxActive = 0, disposeMs, debugTool
    const dispose = () => disposal ??= (async () => {
      const start = performance.now(), errors = []
      for (const off of disposers.toReversed()) { try { await off() } catch (error) { errors.push(error) } }
      disposeMs = performance.now() - start
      if (errors.length) throw new AggregateError(errors, `Failed to dispose ${name}`)
    })()
    const debug = () => debugTool.execute({}, { signal: new AbortController().signal })
    const waitFor = async predicate => {
      const deadline = performance.now() + 10000
      while (!(await predicate())) {
        if (performance.now() > deadline) throw new Error(`Timed out in ${name}`)
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    const recordOutcomes = (turn, expectedStatus) => {
      const records = Object.values(snapshots.get('hermes_memory_runtime')?.global?.reviews || {})
      if (records.length !== sessions) throw new Error(`Invalid ${name} review record count: ${records.length}`)
      for (const record of records) {
        const status = record.status
        reviewOutcomes[status] = (reviewOutcomes[status] || 0) + 1
        if (record.turn !== turn || status !== expectedStatus || (status === 'completed' && record.error)) {
          throw new Error(`${name} review ${record.sessionId} turn ${turn}: expected ${expectedStatus}, got ${status}${record.error ? ': ' + record.error : ''}`)
        }
      }
    }
    try {
      await apply(ctx, { nudgeInterval: 0, backgroundReview: { interval: 1, timeoutMs: reviewTimeoutMs } })
      debugTool = tools.get('memory_debug')
      const participants = Array.from({ length: sessions }, (_, i) => projections.session(`load-${i}`))
      for (let turn = 1; turn <= rounds; turn++) {
        gate = new Promise(resolve => { release = resolve })
        for (const session of participants) {
          const emit = (type, data) => { const event = session.append(type, data); events.get('session/event')?.(session, event) }
          emit('turn/start', { turn })
          emit('user/message', { id: `${session.id}-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(options.evidenceChars) }] })
          emit('assistant/message', { turn, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Synthetic response.' }] } })
          emit('turn/end', { turn, reason: { kind: 'completed' } })
        }
        await waitFor(() => requests === sessions * turn)
        const active = (await debug()).backgroundReview.active
        if (active !== sessions) throw new Error(`Invalid ${name} concurrency: expected ${sessions}, got ${active}`)
        maxActive = Math.max(maxActive, active); sample()
        if (name === 'disposal') { await dispose(); recordOutcomes(turn, 'interrupted'); break }
        release()
        await waitFor(async () => (await debug()).backgroundReview.active === 0)
        recordOutcomes(turn, 'completed')
      }
      await dispose()
      await waitFor(() => activeStreams === 0)
      const activeAfterDispose = (await debug()).backgroundReview.active
      if (activeAfterDispose !== 0 || finishedStreams !== requests || openedUnits !== closedUnits
        || tools.size !== 0 || events.size !== 0 || projections.releases !== 1
        || abortedRequests !== (name === 'disposal' ? requests : 0)) {
        throw new Error(`Incomplete ${name} cleanup or unexpected cancellation`)
      }
      sample()
      phases.push({ name, sessions, rounds, evidenceCharsPerTurn: options.evidenceChars,
        reviewEvidenceUtf16Units: evidenceUnits(sessions, rounds, options.evidenceChars), messageInputUtf16Units,
        requests, maxActive, reviewOutcomes, finishedStreams, abortedRequests, activeAfterDispose,
        elapsedMs: performance.now() - started, disposeMs, before, after: process.memoryUsage(), sampledHighWater,
        storageWrites, openedUnits, closedUnits,
        serializedSnapshotBytes: Buffer.byteLength(JSON.stringify([...snapshots])), diskBytes: null,
        retainedReviewRecords: Object.keys(snapshots.get('hermes_memory_runtime')?.global?.reviews || {}).length })
    } finally { release(); await dispose() }
  }
  return { schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
    totalReviewEvidenceUtf16Units: totalEvidenceUnits(options), maxReviewEvidenceUtf16Units: MAX_REVIEW_EVIDENCE_UTF16_UNITS,
    boundary: 'Actual plugin scheduler, review loop and storage call paths; synthetic sessions/provider and in-memory storage backend. Not host/disk/model performance.',
    memoryMeasurement: 'Process-wide samples, not continuous peak measurement; phases share a process and GC is uncontrolled.', phases }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await characterize(optionsFrom(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
