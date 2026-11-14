import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, rename, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createGuardedStorage } from '../lib/guarded-storage.js'

const main = { name: 'hermes_memory', version: 2, compatibleVersions: [1], tables: ['memory', 'user'], hasGlobal: true }
const runtime = { name: 'hermes_memory_runtime', version: 1, tables: [], hasGlobal: true }
const document = (descriptor, global = null) => JSON.stringify({ unit: { name: descriptor.name, version: descriptor.version }, global, tables: Object.fromEntries(descriptor.tables.map(name => [name, {}])) }, null, 2) + '\n'
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-guarded-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = await createGuardedStorage(root, options)
  t.after(() => backend.close())
  return { root, backend }
}
const code = expected => error => error.code === expected

// All files live under unique temporary roots; real DSH storage is never opened.
test('guarded backend retains DSH JSON layout, legacy tables and detached snapshots', async t => {
  const { root, backend } = await fixture(t)
  await assert.rejects(backend.kv.open({ ...main, name: 'unrelated' }), code('invalid-descriptor'))
  const unit = await backend.kv.open(main)
  await assert.rejects(backend.kv.open(main), code('already-open'))
  await unit.putRecord('memory', 'one', { text: 'Synthetic fact', seq: 1 })
  await unit.putRecord('user', '__proto__', { text: 'Synthetic preference', seq: 2 })
  const loaded = await unit.loadAll()
  loaded.tables.memory.one.text = 'mutated caller copy'
  assert.equal((await unit.loadAll()).tables.memory.one.text, 'Synthetic fact')
  assert.equal((await unit.loadAll()).tables.user.__proto__.text, 'Synthetic preference')
  await unit.setGlobal({ format: 2, tables: { memory: {}, user: {} } })
  const saved = JSON.parse(await readFile(join(root, 'hermes_memory.json'), 'utf8'))
  assert.deepEqual(saved.unit, { name: 'hermes_memory', version: 2 })
  assert.equal(saved.tables.memory.one.text, 'Synthetic fact')
  await unit.deleteRecords('memory', ['one', 'missing'])
  assert.deepEqual((await unit.loadAll()).tables.memory, {})
  await unit.close()
  const reopened = await backend.kv.open(main)
  assert.deepEqual((await reopened.loadAll()).global, saved.global)
  await backend.close()
  const second = await createGuardedStorage(root)
  t.after(() => second.close())
  assert.deepEqual((await (await second.kv.open(main)).loadAll()).global, saved.global)
})

test('guarded backend accepts compatible version on read and restamps only on write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-guarded-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hermes_memory.json')
  await writeFile(path, document({ ...main, version: 1 }, { legacy: true }))
  const backend = await createGuardedStorage(root)
  t.after(() => backend.close())
  await assert.rejects(backend.kv.open({ ...main, compatibleVersions: [] }), code('version-mismatch'))
  const unit = await backend.kv.open(main)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).unit.version, 1)
  await unit.setGlobal({ format: 2 })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).unit.version, 2)
})

test('guarded lease excludes another backend and a genuinely separate process', async t => {
  const { root, backend } = await fixture(t)
  await assert.rejects(createGuardedStorage(root), code('writer-active'))
  const url = new URL('../lib/guarded-storage.js', import.meta.url).href
  const source = `import { createGuardedStorage } from ${JSON.stringify(url)}; try { await createGuardedStorage(process.argv[1]); process.exitCode=2 } catch (error) { process.exitCode=error.code==='writer-active'?0:3 }`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: 'ignore' })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(exit, 0)
  assert.equal(backend.status().state, 'open')
})

test('stale-looking or dead-PID lease is never automatically removed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-guarded-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '.hermes-memory.lock')
  const bytes = JSON.stringify({ token: 'manual-recovery-required', pid: 2147483647, hostname: 'old-host', createdAt: '2000-01-01T00:00:00Z' })
  await writeFile(path, bytes)
  await utimes(path, new Date('2000-01-01'), new Date('2000-01-01'))
  await assert.rejects(createGuardedStorage(root), code('writer-active'))
  assert.equal(await readFile(path, 'utf8'), bytes)
})

for (const changed of ['hermes_memory', 'hermes_memory_runtime']) test('external appearance/edit of ' + changed + ' stops all publication', async t => {
  const { root, backend } = await fixture(t)
  const unit = await backend.kv.open(main)
  await unit.setGlobal({ original: true })
  const path = join(root, changed + '.json')
  const external = document(changed === 'hermes_memory' ? main : runtime, { external: true })
  await writeFile(path, external)
  await assert.rejects(unit.setGlobal({ lostUpdate: true }), code('external-change'))
  assert.equal(await readFile(path, 'utf8'), external)
  assert.equal(backend.status().state, 'poisoned')
  await assert.rejects(unit.loadAll(), code('external-change'))
})

test('unexpected file creation before the first publish is not overwritten', async t => {
  const { root, backend } = await fixture(t)
  const unit = await backend.kv.open(main)
  const path = join(root, 'hermes_memory.json'), external = document(main, { external: true })
  await writeFile(path, external)
  await assert.rejects(unit.setGlobal({ attempted: true }), code('external-change'))
  assert.equal(await readFile(path, 'utf8'), external)
})

test('symlink data path is rejected without touching its referent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-guarded-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'outside')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(target)
  await writeFile(join(target, 'sentinel'), 'unchanged')
  await symlink(target, join(root, 'hermes_memory.json'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createGuardedStorage(root), code('external-change'))
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'unchanged')
})

test('Windows transient rename retries retain one complete temp and do not repeat setGlobal', async t => {
  let attempts = 0
  const sleeps = [], sources = []
  const { root, backend } = await fixture(t, { platform: 'win32', sleep: async ms => { sleeps.push(ms) }, rename: async (from, to) => {
    sources.push(from)
    assert.equal(JSON.parse(await readFile(from, 'utf8')).global.synthetic, true)
    if (++attempts <= 3) throw Object.assign(new Error('transient'), { code: ['EPERM', 'EBUSY', 'EACCES'][attempts - 1] })
    await rename(from, to)
  } })
  const unit = await backend.kv.open(main)
  await unit.setGlobal({ synthetic: true })
  assert.equal(attempts, 4)
  assert.equal(new Set(sources).size, 1)
  assert.deepEqual(sleeps, [10, 20, 40])
  assert.equal(backend.status().state, 'open')
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
})

test('external edit during Windows retry is rechecked and preserved', async t => {
  let attempts = 0, path
  const external = document(runtime, { external: true })
  const { root, backend } = await fixture(t, { platform: 'win32', rename: async () => {
    attempts++
    throw Object.assign(new Error('transient'), { code: 'EPERM' })
  }, sleep: async () => { await writeFile(path, external) } })
  path = join(root, 'hermes_memory_runtime.json')
  const unit = await backend.kv.open(main)
  await assert.rejects(unit.setGlobal({ attempted: true }), code('external-change'))
  assert.equal(attempts, 1)
  assert.equal(await readFile(path, 'utf8'), external)
})

test('Windows retry exhaustion poisons backend without deleting the old target', async t => {
  let attempts = 0
  const { root, backend } = await fixture(t, { platform: 'win32', sleep: async () => {}, rename: async (from, to) => {
    if (++attempts === 1) return rename(from, to)
    throw Object.assign(new Error('transient'), { code: 'EPERM' })
  } })
  const unit = await backend.kv.open(main)
  await unit.setGlobal({ committed: true })
  const path = join(root, 'hermes_memory.json'), original = await readFile(path, 'utf8')
  await assert.rejects(unit.setGlobal({ rejected: true }), code('unknown-state'))
  assert.equal(attempts, 7)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal(backend.status().state, 'poisoned')
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
})

test('non-Windows and nontransient rename failures do not retry', async t => {
  for (const [platform, errorCode] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
    let attempts = 0
    const { backend } = await fixture(t, { platform, rename: async () => {
      attempts++
      throw Object.assign(new Error('permanent'), { code: errorCode })
    }, sleep: async () => { throw new Error('must not sleep') } })
    const unit = await backend.kv.open(main)
    await assert.rejects(unit.setGlobal({ synthetic: true }), code('unknown-state'))
    assert.equal(attempts, 1)
  }
})

test('close drains accepted publication before releasing the lease', async t => {
  let started, finish
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { finish = resolve })
  const { root, backend } = await fixture(t, { rename: async (from, to) => { started(); await gate; await rename(from, to) } })
  const unit = await backend.kv.open(main)
  const writing = unit.setGlobal({ accepted: true })
  await entered
  const closing = backend.close()
  await assert.rejects(createGuardedStorage(root), code('writer-active'))
  finish()
  await writing
  await closing
  assert.equal(backend.status().state, 'closed')
  const successor = await createGuardedStorage(root)
  t.after(() => successor.close())
  assert.equal((await (await successor.kv.open(main)).loadAll()).global.accepted, true)
})

test('publication that commits then reports an error is never retried', async t => {
  let attempts = 0
  const { root, backend } = await fixture(t, { platform: 'win32', sleep: async () => {}, rename: async (from, to) => {
    attempts++
    await rename(from, to)
    throw Object.assign(new Error('uncertain after replacement'), { code: 'EIO' })
  } })
  const unit = await backend.kv.open(main)
  await assert.rejects(unit.setGlobal({ committedButUncertain: true }), code('unknown-state'))
  assert.equal(attempts, 1)
  assert.equal(JSON.parse(await readFile(join(root, 'hermes_memory.json'), 'utf8')).global.committedButUncertain, true)
  await assert.rejects(unit.setGlobal({ mustNotRetry: true }), code('unknown-state'))
  assert.equal(attempts, 1)
})

test('shared write chain preserves concurrent updates across both units', async t => {
  const { backend } = await fixture(t)
  const [unit, metadata] = await Promise.all([backend.kv.open(main), backend.kv.open(runtime)])
  await Promise.all([
    unit.putRecord('memory', 'first', { text: 'first' }),
    metadata.setGlobal({ claim: 'synthetic' }),
    unit.putRecord('memory', 'second', { text: 'second' }),
    unit.putRecord('user', 'third', { text: 'third' }),
  ])
  assert.deepEqual(Object.keys((await unit.loadAll()).tables.memory), ['first', 'second'])
  assert.equal((await unit.loadAll()).tables.user.third.text, 'third')
  assert.deepEqual((await metadata.loadAll()).global, { claim: 'synthetic' })
})

test('malformed stored table rejects without rewriting its bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-guarded-malformed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hermes_memory.json')
  const bytes = JSON.stringify({ unit: { name: main.name, version: 2 }, global: null, tables: { memory: null, user: {} } })
  await writeFile(path, bytes)
  const backend = await createGuardedStorage(root)
  t.after(() => backend.close())
  await assert.rejects(backend.kv.open(main), code('malformed-medium'))
  assert.equal(await readFile(path, 'utf8'), bytes)
})

test('replaced lease poisons and close never deletes a successor token', async t => {
  const { root, backend } = await fixture(t)
  const unit = await backend.kv.open(main)
  const lock = join(root, '.hermes-memory.lock')
  await rename(lock, lock + '.removed')
  const replacement = JSON.stringify({ token: 'successor', pid: process.pid })
  await writeFile(lock, replacement)
  await assert.rejects(unit.setGlobal({ attempted: true }), code('lease-lost'))
  await backend.close()
  assert.equal(await readFile(lock, 'utf8'), replacement)
})
