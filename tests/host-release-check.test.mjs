import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertCompleteTap, validateCheckout, validateBuiltHost, baseline, runTestSuite } from '../scripts/testing/host-release-check.mjs'
const tap = (changes = {}) => Object.entries({ tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes }).map(([key, value]) => `# ${key} ${value}`).join('\n')
test('release gate accepts complete success, rejects skipped, empty, failed, cancelled, todo and malformed summaries', () => {
  assert.equal(assertCompleteTap(tap()).pass, 10)
  assert.equal(assertCompleteTap(tap().replaceAll('\n', '\r\n')).pass, 10)
  for (const changes of [{ skipped: 1 }, { tests: 0, pass: 0 }, { fail: 1 }, { cancelled: 1 }, { todo: 1 }, { pass: 9 }]) assert.throws(() => assertCompleteTap(tap(changes)))
  assert.throws(() => assertCompleteTap(''))
  assert.throws(() => assertCompleteTap(tap() + '\n# skipped 0'))
  for (const value of ['9007199254740992', '9'.repeat(400)]) {
    assert.throws(() => assertCompleteTap(tap({ tests: value, pass: value })), /Invalid TAP tests summary count/)
  }
})
test('release check fails closed for missing checkout and wrong revision', t => {
  assert.throws(() => validateCheckout(''), /DSH_CLIENT_TEST_CHECKOUT/)
  assert.match(baseline.revision, /^[a-f0-9]{40}$/)
  const dir = mkdtempSync(join(tmpdir(), 'hermes-release-check-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => validateBuiltHost(dir), /Build the host first/ )
  const git = args => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git(['init']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic host'])
  assert.throws(() => validateCheckout(dir), /Host HEAD/)
})
test('strict runner executes failing integration files despite inherited name filters, skip filters and shards', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-release-options-'))
  t.after(() => {
    assert.ok(dir.startsWith(join(tmpdir(), 'hermes-release-options-')))
    rmSync(dir, { recursive: true, force: true })
  })
  const files = ['unit', 'integration'].map(name => join(dir, `${name}.test.mjs`))
  writeFileSync(files[0], `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('unit fixture', () => {
  assert.equal(process.env.NODE_OPTIONS, undefined)
  assert.equal(process.env.HERMES_RELEASE_TEST_MARKER, 'preserved')
})
`)
  writeFileSync(files[1], `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('integration fixture', () => assert.fail('integration fixture actually executed'))
`)
  for (const options of ['--test-name-pattern=unit', '--test-skip-pattern=integration', '--test-shard=1/2']) {
    const env = { ...process.env, NODE_OPTIONS: options, HERMES_RELEASE_TEST_MARKER: 'preserved' }
    const result = runTestSuite(files, env)
    assert.equal(env.NODE_OPTIONS, options, 'the caller environment must not be mutated')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, `${options}: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /integration fixture actually executed/)
    assert.match(result.stdout, /^# tests 2\r?$/m)
    assert.throws(() => assertCompleteTap(result.stdout), /requires all tests executed and passed/)
  }
})
