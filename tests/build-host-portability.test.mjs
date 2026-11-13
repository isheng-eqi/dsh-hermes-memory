import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const lf = source => source.replace(/\r\n/g, '\n')
const crlf = source => lf(source).replaceAll('\n', '\r\n')

test('host mirror check accepts CRLF checkouts, rejects stale code and builds LF artifacts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-build-portability-'))
  t.after(() => {
    assert.ok(dir.startsWith(join(tmpdir(), 'hermes-build-portability-')))
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'lib'))
  const script = join(dir, 'scripts', 'build-host.mjs')
  writeFileSync(script, readFileSync(new URL('../scripts/build-host.mjs', import.meta.url), 'utf8'))
  const modules = {
    core: 'export const fixtureCore = 1\n',
    prompts: 'export const fixturePrompt = "fixture prompt"\n',
    review: 'export function fixtureReview() { return true }\n',
    scheduler: 'export const fixtureSchedule = false\n',
    index: `import Schema from 'schemastery'
export const Config = Schema.object({
  fixture: Schema.boolean(),
})
export const name = 'dsh-hermes-memory'
export const inject = ['tools', 'storage']
export async function apply(ctx, config) {
  ctx.tools.register(defineTool({ name: 'fixture' }))
}
export default { name, Config, inject, apply }
`,
  }
  for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, 'lib', `${name}.js`), source)
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
  const succeed = result => {
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  }
  succeed(run())
  const mirror = join(dir, 'host.js')
  const expected = readFileSync(mirror, 'utf8')
  assert.ok(!expected.includes('\r'), 'the LF baseline must contain only LF newlines')
  succeed(run('--check'))

  for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, 'lib', `${name}.js`), crlf(source))
  writeFileSync(mirror, crlf(expected))
  succeed(run('--check'))
  succeed(run())
  assert.equal(readFileSync(mirror, 'utf8'), expected, 'building CRLF sources must reproduce the LF artifact')

  writeFileSync(join(dir, 'lib', 'core.js'), crlf('export const fixtureCore = 2\n'))
  const staleSource = run('--check')
  assert.equal(staleSource.status, 1)
  assert.match(staleSource.stderr, /host\.js is stale/)
  writeFileSync(join(dir, 'lib', 'core.js'), crlf(modules.core))
  writeFileSync(mirror, crlf(expected.replace('const fixtureCore = 1', 'const fixtureCore = 999')))
  const staleMirror = run('--check')
  assert.equal(staleMirror.status, 1)
  assert.match(staleMirror.stderr, /host\.js is stale/)
})
