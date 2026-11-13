import { test } from 'node:test'
import assert from 'node:assert/strict'
import { characterize, optionsFrom } from '../scripts/characterize-resources.mjs'

const small = { sessions: 3, rounds: 2, evidenceChars: 64 }

test('resource workload rejects invalid and oversized inputs including replay and all phases', () => {
  for (const args of [['--sessions=0'], ['--rounds=21'], ['--evidenceChars=16385'], ['--sessions=NaN'], ['--sessions=2.5'], ['--other=1'], ['--sessions=32', '--rounds=20', '--evidenceChars=16384']]) assert.throws(() => optionsFrom(args))
  // The old new-text-only cap accepted this despite 21,000,000 replayed evidence units.
  assert.throws(() => optionsFrom(['--sessions=32', '--rounds=20', '--evidenceChars=3125']), /history replay and all phases/)
  assert.deepEqual(optionsFrom(['--sessions=32', '--rounds=20', '--evidenceChars=296']), {sessions: 32, rounds: 20, evidenceChars: 296})
  assert.throws(() => optionsFrom(['--sessions=32', '--rounds=20', '--evidenceChars=297']), /UTF-16/)
  // Concurrent input alone is 1,999,830 units; baseline and disposal push it over the cap.
  assert.throws(() => optionsFrom(['--sessions=1', '--rounds=20', '--evidenceChars=9523']), /all phases/)
})

test('resource characterization verifies outcomes, concurrency and complete disposal offline', async () => {
  let measuredEvidence = 0, messageInput = 0
  async function* streamFactory({input, signal}) {
    assert.equal(signal.aborted, false)
    messageInput += JSON.stringify(input.messages).length
    const evidence = JSON.parse(input.messages[0].content[0].text.split('\n').slice(1).join('\n'))
    measuredEvidence += evidence.filter(message => message.role === 'user').reduce((sum, message) => sum + message.content.length, 0)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const result = await characterize(small, { streamFactory })
  assert.equal(result.schemaVersion, 1)
  assert.match(result.boundary, /in-memory/)
  assert.deepEqual(result.phases.map(p => p.name), ['baseline', 'concurrent', 'disposal'])
  const [baseline, concurrent, disposal] = result.phases
  assert.equal(baseline.requests, 1)
  assert.equal(concurrent.requests, 6)
  assert.equal(concurrent.maxActive, 3)
  assert.equal(disposal.maxActive, 3)
  assert.equal(disposal.requests, 3)
  assert.deepEqual(result.phases.map(p => p.reviewEvidenceUtf16Units), [64, 576, 192])
  assert.equal(result.totalReviewEvidenceUtf16Units, 832)
  assert.equal(result.totalReviewEvidenceUtf16Units, result.phases.reduce((sum, phase) => sum + phase.reviewEvidenceUtf16Units, 0))
  assert.ok(result.totalReviewEvidenceUtf16Units <= result.maxReviewEvidenceUtf16Units)
  // The disposal provider is aborted before it passes the gate, but its input was admitted.
  assert.equal(measuredEvidence, baseline.reviewEvidenceUtf16Units + concurrent.reviewEvidenceUtf16Units)
  assert.equal(messageInput, baseline.messageInputUtf16Units + concurrent.messageInputUtf16Units)
  for (const phase of result.phases) {
    assert.deepEqual(phase.reviewOutcomes, phase.name === 'disposal' ? {interrupted: 3} : {completed: phase.requests})
    assert.equal(phase.activeAfterDispose, 0)
    assert.equal(phase.finishedStreams, phase.requests)
    assert.equal(phase.abortedRequests, phase.name === 'disposal' ? phase.requests : 0)
    assert.equal(phase.openedUnits, phase.closedUnits)
    assert.ok(phase.storageWrites >= phase.sessions * phase.rounds * 2)
    assert.equal(phase.retainedReviewRecords, phase.sessions)
    assert.ok(phase.serializedSnapshotBytes > 0)
    assert.equal(phase.diskBytes, null)
    for (const metric of [phase.elapsedMs, phase.disposeMs, phase.sampledHighWater.heapUsed, phase.sampledHighWater.rss]) assert.ok(Number.isFinite(metric) && metric >= 0)
  }
})

test('resource characterization rejects provider error, thrown failures and malformed completion', async () => {
  for (const streamFactory of [
    async function* () { yield { type: 'finish', reason: { kind: 'error', failure: {message: 'synthetic provider failed'} } } },
    async function* () { throw new Error('synthetic stream failed') },
    async function* () { yield { type: 'block-end', index: 0, block: {type: 'text', text: 'No finish'} } },
  ]) {
    await assert.rejects(characterize(small, { streamFactory }), /expected completed, got error/)
  }
})

test('resource characterization rejects timed-out normal reviews and closes the synthetic stream', async () => {
  let finished = false
  async function* streamFactory({signal}) {
    try {
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, {once: true})
      })
    } finally { finished = true }
  }
  await assert.rejects(characterize(small, { streamFactory, reviewTimeoutMs: 25 }), /expected completed, got interrupted.*timed out/)
  assert.equal(finished, true)
})

test('programmatic resource options are validated before a workload starts', async () => {
  await assert.rejects(characterize({sessions: 32, rounds: 20, evidenceChars: 3125}), /UTF-16/)
  await assert.rejects(characterize({...small, unexpected: 1}), /Expected --/)
  await assert.rejects(characterize(small, {reviewTimeoutMs: 0}), /Invalid synthetic/)
  await assert.rejects(characterize(small, {streamFactory: null}), /Invalid synthetic/)
})
