import { test } from 'node:test'
import assert from 'node:assert/strict'
import { characterize, optionsFrom } from '../scripts/characterize-resources.mjs'

test('resource workload rejects invalid and oversized inputs', () => {
  for (const args of [['--sessions=0'], ['--rounds=21'], ['--evidenceChars=16385'], ['--sessions=NaN'], ['--sessions=2.5'], ['--other=1'], ['--sessions=32', '--rounds=20', '--evidenceChars=16384']]) assert.throws(() => optionsFrom(args))
})

test('resource characterization exercises concurrency, storage and pending-review disposal offline', async () => {
  const result = await characterize({ sessions: 3, rounds: 2, evidenceChars: 64 })
  assert.equal(result.schemaVersion, 1)
  assert.match(result.boundary, /in-memory/)
  assert.deepEqual(result.phases.map(p => p.name), ['baseline', 'concurrent', 'disposal'])
  const [baseline, concurrent, disposal] = result.phases
  assert.equal(baseline.requests, 1)
  assert.equal(concurrent.requests, 6)
  assert.equal(concurrent.maxActive, 3)
  assert.equal(disposal.maxActive, 3)
  assert.equal(disposal.requests, 3)
  for (const phase of result.phases) {
    assert.equal(phase.openedUnits, phase.closedUnits)
    assert.ok(phase.storageWrites >= phase.sessions * phase.rounds * 2)
    assert.equal(phase.retainedReviewRecords, phase.sessions)
    assert.ok(phase.serializedSnapshotBytes > 0)
    assert.equal(phase.diskBytes, null)
    for (const metric of [phase.elapsedMs, phase.disposeMs, phase.sampledHighWater.heapUsed, phase.sampledHighWater.rss]) assert.ok(Number.isFinite(metric) && metric >= 0)
  }
})
