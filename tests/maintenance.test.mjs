import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compactRuntime, createMemoryExport, payloadSha256, validateRuntime } from '../lib/maintenance.js'

const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const before = '2026-06-01T00:00:00.000Z'
const old = '2026-01-01T00:00:00.000Z'
const options = { before, maxDetailed: 0, now: '2026-11-14T00:00:00.000Z' }
const proposal = (id, status = 'approved', finishedAt = old) => ({ id, target: 'user', status, createdAt: old, finishedAt,
  operations: [{ action: 'patch', old_text: 'Old text', content: 'New text' }], pins: [{ operation: 0, seq: 9, matched_entry: 'Old text' }],
  provenance: { asOfSeq: 42, userTurnCount: 10, sourceMessageIds: ['source-1'], content: 'Sensitive evidence' } })
const review = (turn = 10, status = 'completed', finishedAt = old) => ({ sessionId: 'synthetic-session', turn, status, finishedAt,
  provenance: { asOfSeq: 32, text: 'Sensitive source evidence' } })
const empty = () => ({ format: 1, pending: {}, reviews: {} })
const record = (text, seq) => ({ text, seq, createdAt: old })

test('portable SHA-256 agrees with Node crypto for canonical Unicode JSON and multi-block inputs', () => {
  for (const value of ['', 'abc', 'a'.repeat(1000), '😀中文e\u0301', '\ud800\udfff\udc00', { z: true, a: [1, null, { b: 'c' }] }]) {
    assert.equal(payloadSha256(value), createHash('sha256').update(canonical(value), 'utf8').digest('hex'))
  }
  assert.equal(payloadSha256({ a: 1, b: 2 }), payloadSha256({ b: 2, a: 1 }))
})

test('compaction removes resolved content while preserving claim and proposal identities without mutation', () => {
  const data = { format: 1, pending: { p: proposal('p') }, reviews: { 'session:synthetic-session': review() } }
  const original = structuredClone(data)
  const { data: compacted, summary } = compactRuntime(data, options)
  assert.deepEqual(data, original)
  assert.equal(summary.changed, true)
  assert.equal(summary.compactedProposals, 1)
  assert.equal(summary.compactedReviews, 1)
  assert.equal(compacted.pending.p.id, 'p')
  assert.equal(compacted.pending.p.target, 'user')
  assert.deepEqual(compacted.pending.p.pinnedIdentities, [{ operation: 0, seq: 9 }])
  assert.equal(compacted.pending.p.payloadSha256, payloadSha256(original.pending.p))
  assert.equal(compacted.reviews['session:synthetic-session'].turn, 10)
  assert.equal(compacted.reviews['session:synthetic-session'].sessionId, 'synthetic-session')
  assert.ok(!JSON.stringify(compacted).includes('Sensitive'))
  assert.equal(compacted.pending.p.operations, undefined)
  const repeated = compactRuntime(compacted, { ...options, now: '2026-11-15T00:00:00.000Z' })
  assert.equal(repeated.summary.changed, false)
  assert.deepEqual(repeated.data, compacted)
})

test('pending, applying, interrupted, active and unknown statuses retain complete evidence', () => {
  const data = empty()
  for (const status of ['pending', 'applying', 'interrupted', 'future-status']) data.pending[status] = proposal(status, status)
  data.reviews.running = review(50, 'running')
  data.reviews.unknown = review(60, 'future-status')
  assert.deepEqual(compactRuntime(data, options).data, data)
})

test('age, valid finish time, and newest detailed allowance independently protect records', () => {
  const data = empty()
  data.pending.noFinish = proposal('noFinish', 'approved', undefined)
  delete data.pending.noFinish.finishedAt
  data.pending.invalid = proposal('invalid', 'approved', 'invalid')
  data.pending.new = proposal('new', 'approved', '2026-07-01T00:00:00.000Z')
  data.pending.cutoff = proposal('cutoff', 'approved', before)
  data.pending.old = proposal('old')
  assert.equal(compactRuntime(data, options).summary.compactedProposals, 1)
  assert.equal(compactRuntime(data, { ...options, maxDetailed: 3 }).summary.changed, false)
  const sameTime = empty()
  sameTime.pending.z = proposal('z')
  sameTime.pending.a = proposal('a')
  const result = compactRuntime(sameTime, { ...options, maxDetailed: 1 }).data
  assert.equal(result.pending.a.compacted, undefined)
  assert.equal(result.pending.z.compacted, true)
})

test('default detailed allowance bounds eligible old payloads without deleting any replay markers', () => {
  const data = empty()
  for (let i = 0; i < 1000; i++) {
    data.pending['p' + i] = proposal('p' + i)
    data.pending['p' + i].provenance.content = 'Synthetic source evidence. '.repeat(100)
    data.reviews['session:s' + i] = { ...review(i), sessionId: 's' + i, provenance: { text: 'Synthetic review evidence. '.repeat(100) } }
  }
  const compacted = compactRuntime(data, { before, now: options.now })
  assert.equal(Object.keys(compacted.data.pending).length, 1000)
  assert.equal(Object.keys(compacted.data.reviews).length, 1000)
  for (const rows of [compacted.data.pending, compacted.data.reviews]) assert.equal(Object.values(rows).filter(row => !row.compacted).length, 100)
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.data)) < Buffer.byteLength(JSON.stringify(data)))
})

test('malformed metadata, non-ISO cutoffs and invalid allowances fail before any mutation', () => {
  for (const data of [null, {}, { ...empty(), pending: [] }, { ...empty(), pending: { p: null } }, { ...empty(), reviews: { r: { status: 'completed', turn: -1 } } },
    { ...empty(), pending: { p: { status: 'pending', pins: [{ seq: -1, operation: 0 }] } } }]) assert.throws(() => validateRuntime(data), /Malformed/)
  for (const before of [undefined, '', 'invalid', '2026-01-01']) assert.throws(() => compactRuntime(empty(), { before }), /ISO/)
  for (const maxDetailed of [-1, 0.1, Infinity, '2', 10001]) assert.throws(() => compactRuntime(empty(), { ...options, maxDetailed }), /maxDetailed/)
})

test('export uses authoritative v2 records, preserves full bookkeeping and has no public-list cap', () => {
  const tables = { memory: {}, user: { preference: record('用户😀 preference', 1) } }
  for (let i = 130; i > 0; i--) tables.memory['r' + i] = record('Synthetic ' + i, i)
  const memory = { global: { format: 2, tables, seqHighWater: { memory: 130, user: 1 } }, tables: { memory: { old: record('Obsolete record', 1) }, user: {} } }
  const runtime = { global: { format: 1, pending: { p: proposal('p', 'interrupted') }, reviews: { 'session:s': review() } }, tables: {} }
  const original = structuredClone({ memory, runtime })
  const exported = createMemoryExport(memory, runtime, { createdAt: options.now })
  assert.equal(exported.entries.memory.length, 130)
  assert.equal(exported.entries.memory[0], 'Synthetic 1')
  assert.equal(exported.entries.memory[129], 'Synthetic 130')
  assert.deepEqual(exported.entries.user, ['用户😀 preference'])
  assert.deepEqual(exported.v1Document, { unit: { name: 'hermes_memory', version: 1 }, global: null, tables })
  assert.deepEqual(exported.bookkeeping, { memorySnapshot: memory, runtimeSnapshot: runtime })
  exported.v1Document.tables.user.preference.text = 'Changed copy'
  exported.bookkeeping.runtimeSnapshot.global.pending.p.status = 'discarded'
  assert.deepEqual({ memory, runtime }, original)
})

test('legacy and empty exports work; unsupported or corrupt snapshots never fall back to stale v1 tables', () => {
  const memory = { global: null, tables: { memory: {}, user: {} } }
  const runtime = { global: null, tables: {} }
  assert.deepEqual(createMemoryExport(memory, runtime).entries, { memory: [], user: [] })
  for (const global of [{ format: 3 }, { format: 2, tables: [] }, { format: 2, tables: { memory: { x: record('x', 1), y: record('y', 1) }, user: {} } },
    { format: 2, tables: memory.tables, seqHighWater: { memory: -1, user: 0 } }]) assert.throws(() => createMemoryExport({ ...memory, global }, runtime), /Unsupported|Malformed/)
  assert.throws(() => createMemoryExport(memory, { global: { format: 2 }, tables: {} }), /Malformed/)
})
