import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const baseline = JSON.parse(readFileSync(new URL('./host-baseline.json', import.meta.url), 'utf8'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const required = [
  'packages/core/session/lib/index.js',
  'packages/storage/storage-json/lib/index.js',
  'packages/session/session-persistence-jsonl/lib/index.js',
  'packages/extensions/cordis-host-runner/lib/types/sandbox.js',
  'packages/llm/llm/lib/index.js',
  'packages/client/ui-renderer/lib/client.js',
  'packages/client/ui-slots/lib/index.js',
]
export function validateCheckout(checkout) {
  if (!checkout) throw new Error('Set DSH_CLIENT_TEST_CHECKOUT to the built pinned host checkout')
  const directory = resolve(checkout)
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
  if (git(['rev-parse', 'HEAD']) !== baseline.revision) throw new Error(`Host HEAD must be ${baseline.revision}`)
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Host tracked source must be clean; rebuild from the pinned revision')
  validateBuiltHost(directory)
  return directory
}
export function validateBuiltHost(directory) {
  const missing = required.filter(path => !existsSync(join(directory, path)))
  if (missing.length) throw new Error(`Build the host first; missing: ${missing.join(', ')}`)
}
export function assertCompleteTap(output) {
  const count = key => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))]
    if (matches.length !== 1) throw new Error(`Missing or ambiguous TAP ${key} summary`)
    const value = Number(matches[0][1])
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid TAP ${key} summary count`)
    return value
  }
  const result = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, count(key)]))
  if (result.tests === 0 || result.pass !== result.tests || result.fail || result.cancelled || result.skipped || result.todo) {
    throw new Error(`Release verification requires all tests executed and passed: ${JSON.stringify(result)}`)
  }
  return result
}
export function runTestSuite(files, env = process.env) {
  const childEnv = { ...env }
  // Inherited filters/shards can omit tests without reporting skips. A nested
  // node:test context can suppress the new runner altogether.
  for (const key of Object.keys(childEnv)) {
    if (['NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase())) delete childEnv[key]
  }
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  })
}
export function main() {
  const checkout = validateCheckout(process.env.DSH_CLIENT_TEST_CHECKOUT)
  console.log(`Host baseline: ${baseline.repository}@${baseline.revision}; Node ${process.version}`)
  execFileSync(process.execPath, ['scripts/build-host.mjs', '--check'], { cwd: root, stdio: 'inherit' })
  const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name))
  const result = runTestSuite(files, { ...process.env, DSH_CLIENT_TEST_CHECKOUT: checkout })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Test process failed (${result.status ?? result.signal})`)
  console.log('Verified release test summary:', assertCompleteTap(result.stdout))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
