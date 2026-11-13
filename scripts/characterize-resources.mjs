/** Offline component characterization. Never opens a user profile or calls a model. */
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { apply } from '../lib/index.js'
import { projectionFixture, timers } from '../tests/host-fixture.mjs'

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
  if (options.sessions * options.rounds * options.evidenceChars > 2000000) throw new Error('Synthetic input exceeds 2,000,000 characters')
  return options
}

export async function characterize(options = optionsFrom([])) {
  // Validate programmatic callers too.
  options = optionsFrom(Object.entries(options).map(([key, value]) => `--${key}=${value}`))
  const phases = []
  for (const [name, sessions, rounds] of [['baseline', 1, 1], ['concurrent', options.sessions, options.rounds], ['disposal', options.sessions, 1]]) {
    const started = performance.now(), before = process.memoryUsage()
    const sampledHighWater = { heapUsed: before.heapUsed, rss: before.rss }
    const sample = () => { const m = process.memoryUsage(); for (const key of Object.keys(sampledHighWater)) sampledHighWater[key] = Math.max(sampledHighWater[key], m[key]) }
    const snapshots = new Map(), events = new Map(), tools = new Map(), disposers = []
    const projections = projectionFixture()
    let requests = 0, storageWrites = 0, closedUnits = 0, openedUnits = 0
    let release
    let gate = new Promise(resolve => { release = resolve })
    const backend = { kv: { async open(descriptor) {
      openedUnits++
      if (!snapshots.has(descriptor.name)) snapshots.set(descriptor.name, { global: null, tables: descriptor.name === 'hermes_memory' ? { memory: {}, user: {} } : {} })
      return {
        loadAll: async () => structuredClone(snapshots.get(descriptor.name)),
        async setGlobal(global) { storageWrites++; snapshots.get(descriptor.name).global = structuredClone(global); sample() },
        async close() { closedUnits++ },
      }
    } } }
    const llm = { async prepareCall(config, signal) { return { config, async *stream() {
      requests++; sample()
      await Promise.race([gate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No durable fact in this synthetic load.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } }
    const services = { storage: { backend: { get: () => backend } }, sessions: { flush: async () => true }, llm }
    const ctx = { ...timers, sessionProjections: projections.service,
      get: key => services[key],
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
      on(event, handler) { events.set(event, handler); return () => events.delete(event) },
    }
    let disposed = false, maxActive = 0, disposeMs
    const dispose = async () => { if (disposed) return; disposed = true; const start = performance.now(); for (const off of disposers.toReversed()) await off(); disposeMs = performance.now() - start }
    const debug = () => tools.get('memory_debug').execute({}, { signal: new AbortController().signal })
    const waitFor = async predicate => {
      const deadline = performance.now() + 10000
      while (!(await predicate())) {
        if (performance.now() > deadline) throw new Error(`Timed out in ${name}`)
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    try {
      await apply(ctx, { nudgeInterval: 0, backgroundReview: { interval: 1 } })
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
        maxActive = Math.max(maxActive, (await debug()).backgroundReview.active); sample()
        if (name === 'disposal') { await dispose(); break }
        release()
        await waitFor(async () => (await debug()).backgroundReview.active === 0)
      }
      await dispose(); sample()
      phases.push({ name, sessions, rounds, evidenceCharsPerTurn: options.evidenceChars, requests, maxActive,
        elapsedMs: performance.now() - started, disposeMs, before, after: process.memoryUsage(), sampledHighWater,
        storageWrites, openedUnits, closedUnits,
        serializedSnapshotBytes: Buffer.byteLength(JSON.stringify([...snapshots])), diskBytes: null,
        retainedReviewRecords: Object.keys(snapshots.get('hermes_memory_runtime')?.global?.reviews || {}).length })
    } finally { release(); await dispose() }
  }
  return { schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
    boundary: 'Actual plugin scheduler, review loop and storage call paths; synthetic sessions/provider and in-memory storage backend. Not host/disk/model performance.',
    memoryMeasurement: 'Process-wide samples, not continuous peak measurement; phases share a process and GC is uncontrolled.', phases }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await characterize(optionsFrom(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
