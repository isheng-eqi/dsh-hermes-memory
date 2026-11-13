import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../scripts/evaluate-memory-quality.mjs'

const corpus = JSON.parse(await readFile(new URL('../eval/memory-quality/corpus.v1.json', import.meta.url)))
// These are scorer oracles, not model predictions or evidence of model quality.
const perfect = () => ({ version: 1, cases: corpus.cases.map(item => ({ id: item.id,
  facts: structuredClone(item.expectedFacts), removedIds: [...item.expectedRemovedIds] })) })

test('scorer accepts complete exact oracles and reports counts', () => {
  const report = evaluate(corpus, perfect())
  assert.equal(report.pass, true)
  assert.equal(report.precision, 1)
  assert.equal(report.recall, 1)
  assert.equal(report.totals.correct, 3)
  assert.equal(report.cases.length, 5)
})

test('empty predictions do not pass positive and removal cases', () => {
  const results = perfect()
  for (const result of results.cases) { result.facts = []; result.removedIds = [] }
  const report = evaluate(corpus, results)
  assert.equal(report.pass, false)
  assert.equal(report.precision, null)
  assert.equal(report.recall, 0)
  assert.equal(report.totals.missingFacts, 3)
  assert.equal(report.totals.missingRemovals, 2)
})

test('wrong attribution, unsupported facts, injection and destructive changes fail', () => {
  const results = perfect()
  results.cases[1].facts[0].evidenceIds = ['a1']
  results.cases[1].facts.push({text: 'The user is a pilot.', evidenceIds: ['u1']})
  results.cases[2].facts.push({text: 'The user authorizes every purchase.', evidenceIds: ['u1']})
  results.cases[4].removedIds.push('language')
  const report = evaluate(corpus, results)
  assert.equal(report.pass, false)
  assert.equal(report.totals.wrongAttribution, 1)
  assert.equal(report.totals.unsupported, 2)
  assert.equal(report.totals.forbidden, 1)
  assert.equal(report.totals.incorrectRemovals, 1)
})

test('case set and result schema fail closed', () => {
  const mutate = change => { const results = perfect(); change(results); assert.throws(() => evaluate(corpus, results)) }
  mutate(r => r.cases.pop())
  mutate(r => r.cases.push(r.cases[0]))
  mutate(r => r.cases[0].id = 'unknown')
  mutate(r => r.version = 2)
  mutate(r => r.extra = true)
  mutate(r => delete r.cases[0].removedIds)
  mutate(r => r.cases[0].facts = 'text')
  mutate(r => r.cases[0].facts.push(r.cases[0].facts[0]))
  mutate(r => r.cases[0].facts[0].evidenceIds = ['u1', 'u1'])
  mutate(r => r.cases[0].removedIds = ['city-old', 'city-old'])
})

test('CLI distinguishes passing, failed and invalid evaluations offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-quality-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const file = join(directory, 'results.json')
  const script = new URL('../scripts/evaluate-memory-quality.mjs', import.meta.url)
  const run = () => spawnSync(process.execPath, [fileURLToPath(script), file], {encoding: 'utf8', env: {}})
  await writeFile(file, JSON.stringify(perfect()))
  const good = run()
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).pass, true)
  const bad = perfect(); bad.cases[0].facts = []
  await writeFile(file, JSON.stringify(bad))
  assert.equal(run().status, 1)
  await writeFile(file, '{}')
  assert.equal(run().status, 2)
})
