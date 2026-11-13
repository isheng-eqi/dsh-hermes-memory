/** Offline exact-oracle evaluation of externally produced synthetic memory changes. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value))
function requireShape(value, keys, label) {
  if (!object(value) || !sameSet(Object.keys(value), keys)) throw new Error(`Invalid ${label} fields`)
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) {
    throw new Error(`Invalid or duplicate ${label}`)
  }
}

export function evaluate(corpus, results) {
  if (corpus.version !== 1 || !Array.isArray(corpus.cases)) throw new Error('Unsupported corpus')
  requireShape(results, ['version', 'cases'], 'results')
  if (results.version !== corpus.version || !Array.isArray(results.cases)) throw new Error('Wrong results version or cases')
  const expectedIds = corpus.cases.map(item => item.id)
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error('Duplicate corpus case')
  const receivedIds = results.cases.map(item => item?.id)
  if (new Set(receivedIds).size !== receivedIds.length || !sameSet(expectedIds, receivedIds)) throw new Error('Missing, duplicate or unknown result cases')
  const cases = corpus.cases.map(fixture => {
    const result = results.cases.find(item => item.id === fixture.id)
    requireShape(result, ['id', 'facts', 'removedIds'], `case ${fixture.id}`)
    if (!Array.isArray(result.facts)) throw new Error('Facts must be an array')
    strings(result.removedIds, 'removedIds')
    const seen = new Set()
    let correct = 0, unsupported = 0, forbidden = 0, wrongAttribution = 0
    for (const fact of result.facts) {
      requireShape(fact, ['text', 'evidenceIds'], 'fact')
      if (typeof fact.text !== 'string' || !fact.text.trim() || seen.has(fact.text)) throw new Error('Invalid or duplicate fact')
      seen.add(fact.text)
      strings(fact.evidenceIds, 'evidenceIds')
      const expected = fixture.expectedFacts.find(item => item.text === fact.text)
      if (fixture.forbiddenFacts.includes(fact.text)) forbidden++
      if (!expected) unsupported++
      else if (!sameSet(expected.evidenceIds, fact.evidenceIds)) wrongAttribution++
      else correct++
    }
    const incorrectRemovals = result.removedIds.filter(id => !fixture.expectedRemovedIds.includes(id)).length
    const missingRemovals = fixture.expectedRemovedIds.filter(id => !result.removedIds.includes(id)).length
    const missingFacts = fixture.expectedFacts.length - correct
    return { id: fixture.id, expected: fixture.expectedFacts.length, emitted: result.facts.length,
      correct, unsupported, forbidden, wrongAttribution, missingFacts, incorrectRemovals, missingRemovals,
      pass: unsupported + forbidden + wrongAttribution + missingFacts + incorrectRemovals + missingRemovals === 0 }
  })
  const totals = Object.fromEntries(['expected', 'emitted', 'correct', 'unsupported', 'forbidden', 'wrongAttribution', 'missingFacts', 'incorrectRemovals', 'missingRemovals']
    .map(key => [key, cases.reduce((sum, item) => sum + item[key], 0)]))
  return { version: corpus.version, evaluation: 'synthetic-exact-oracle', cases, totals,
    precision: totals.emitted ? totals.correct / totals.emitted : null,
    recall: totals.expected ? totals.correct / totals.expected : null,
    pass: cases.every(item => item.pass) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/evaluate-memory-quality.mjs RESULTS.json')
    const corpus = JSON.parse(await readFile(new URL('../eval/memory-quality/corpus.v1.json', import.meta.url), 'utf8'))
    const results = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const report = evaluate(corpus, results)
    console.log(JSON.stringify(report, null, 2))
    if (!report.pass) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
