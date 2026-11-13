import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertCompleteTap, validateCheckout, validateBuiltHost, baseline } from '../scripts/testing/host-release-check.mjs'
const tap = (changes = {}) => Object.entries({ tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes }).map(([key, value]) => `# ${key} ${value}`).join('\n')
test('release gate accepts complete success, rejects skipped, empty, failed, cancelled, todo and malformed summaries', () => {
  assert.equal(assertCompleteTap(tap()).pass, 10)
  for (const changes of [{ skipped: 1 }, { tests: 0, pass: 0 }, { fail: 1 }, { cancelled: 1 }, { todo: 1 }, { pass: 9 }]) assert.throws(() => assertCompleteTap(tap(changes)))
  assert.throws(() => assertCompleteTap(''))
  assert.throws(() => assertCompleteTap(tap() + '\n# skipped 0'))
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
