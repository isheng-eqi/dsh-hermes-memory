import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'
import { main as maintain } from '../scripts/memory-maintenance.mjs'
import { createGuardedStorage } from '../lib/guarded-storage.js'
import { projectionFixture, timers } from './host-fixture.mjs'

const record = (text, seq) => ({ text, seq, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
const document = (name, version, global, tables) => JSON.stringify({ unit: { name, version }, global, tables }, null, 2) + '\n'
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-persistence-maintenance-'))
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'hermes-persistence-maintenance-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}
async function mount(root) {
  const tools = new Map(), disposers = [], projections = projectionFixture()
  const session = projections.session('guarded-synthetic')
  await apply({ ...timers,
    sessionProjections: projections.service,
    get: () => undefined,
    on() {},
    effect(fn) { const off = fn(); if (off) disposers.push(off) },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }, { storageRoot: root, nudgeInterval: 0 })
  let disposed = false
  return {
    call: (name, args = {}) => tools.get(name).execute(args, { agent: { session }, signal: new AbortController().signal }),
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const off of disposers.toReversed()) await off()
    },
  }
}

test('static guarded configuration owns both files, refuses another backend, detects edits and reopens cleanly', async t => {
  const root = await temporary(t)
  const first = await mount(root)
  t.after(first.dispose)
  assert.equal((await first.call('memory_stats')).storageSafety.mode, 'guarded-native')
  assert.equal((await first.call('memory', { target: 'user', operations: [{ action: 'add', content: 'Synthetic current preference' }] })).success, true)
  const second = await mount(root)
  t.after(second.dispose)
  const unavailable = await second.call('memory_stats')
  assert.equal(unavailable.ready, false)
  assert.match(unavailable.error, /lease already exists/)
  await assert.rejects(second.call('memory_pending', { action: 'list' }), /lease already exists/)
  await second.dispose()
  assert.equal((await first.call('memory_stats')).ready, true)
  const runtimePath = join(root, 'hermes_memory_runtime.json')
  await writeFile(runtimePath, document('hermes_memory_runtime', 1, { format: 1, pending: {}, reviews: {} }, {}))
  await assert.rejects(first.call('memory', { target: 'user', operations: [{ action: 'add', content: 'Should not publish' }] }), /outside this writer/)
  assert.equal((await first.call('memory_stats')).ready, false)
  assert.ok(!(await readFile(join(root, 'hermes_memory.json'), 'utf8')).includes('Should not publish'))
  await first.dispose()
  const restored = await mount(root)
  t.after(restored.dispose)
  assert.deepEqual((await restored.call('memory_list')).user, ['Synthetic current preference'])
  assert.equal((await restored.call('memory', { target: 'user', operations: [{ action: 'add', content: 'After inspection' }] })).success, true)
})

test('offline export and v1 extraction use current entries, never overwrite live files, and compact only after backup', async t => {
  const root = await temporary(t)
  const current = { memory: { now: record('Current synthetic environment', 3) }, user: { pref: record('Synthetic preference', 4) } }
  const memoryPath = join(root, 'hermes_memory.json')
  const runtimePath = join(root, 'hermes_memory_runtime.json')
  const memoryText = document('hermes_memory', 2, { format: 2, tables: current, seqHighWater: { memory: 3, user: 4 } }, { memory: { old: record('Obsolete recovery record', 1) }, user: {} })
  const runtime = { format: 1, pending: { resolved: { id: 'resolved', target: 'user', status: 'approved', finishedAt: '2026-01-01T00:00:00.000Z', operations: [{ action: 'add', content: 'Private historical payload' }], pins: [] } }, reviews: {} }
  const runtimeText = document('hermes_memory_runtime', 1, runtime, {})
  await writeFile(memoryPath, memoryText)
  await writeFile(runtimePath, runtimeText)
  const backupPath = join(root, 'backup.json')
  assert.equal((await maintain(['export', '--root', root, '--out', backupPath])).success, true)
  const backup = JSON.parse(await readFile(backupPath, 'utf8'))
  assert.deepEqual(backup.entries, { memory: ['Current synthetic environment'], user: ['Synthetic preference'] })
  assert.deepEqual(backup.v1Document.tables, current)
  assert.equal(await readFile(memoryPath, 'utf8'), memoryText)
  assert.equal(await readFile(runtimePath, 'utf8'), runtimeText)
  await assert.rejects(maintain(['compact', '--root', root, '--out', backupPath, '--before', '2026-02-01T00:00:00.000Z', '--keep', '0']), /EEXIST/)
  assert.equal(await readFile(runtimePath, 'utf8'), runtimeText)
  const beforeCompact = join(root, 'before-compaction.json')
  assert.equal((await maintain(['compact', '--root', root, '--out', beforeCompact, '--before', '2026-02-01T00:00:00.000Z', '--keep', '0'])).changed, true)
  assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).global.pending.resolved.compacted, true)
  assert.deepEqual(JSON.parse(await readFile(beforeCompact, 'utf8')).bookkeeping.runtimeSnapshot.global, runtime)
  const recoveryRoot = await temporary(t)
  const extracted = join(recoveryRoot, 'hermes_memory.json')
  assert.equal((await maintain(['extract-v1', '--root', backupPath, '--out', extracted])).installed, false)
  const recovered = JSON.parse(await readFile(extracted, 'utf8'))
  assert.deepEqual(recovered, { unit: { name: 'hermes_memory', version: 1 }, global: null, tables: current })
  await assert.rejects(maintain(['export', '--root', root, '--out', memoryPath]), /live storage path/)
  await assert.rejects(access(join(root, '.hermes-memory.lock')), { code: 'ENOENT' })
})

test('offline output paths cannot create a live file through Windows case aliases or v1 extraction', async t => {
  const root = await temporary(t)
  const backupRoot = await temporary(t)
  const backup = join(backupRoot, 'backup.json')
  await maintain(['export', '--root', root, '--out', backup])
  if (process.platform === 'win32') {
    await assert.rejects(maintain(['export', '--root', root, '--out', join(root, 'HERMES_MEMORY.JSON')]), /live storage path/)
    await assert.rejects(access(join(root, 'hermes_memory.json')), { code: 'ENOENT' })
  }
  const lease = await createGuardedStorage(root)
  try { await assert.rejects(maintain(['extract-v1', '--root', backup, '--out', join(root, 'hermes_memory.json')]), /lease already exists/) }
  finally { await lease.close() }
  await writeFile(join(root, 'hermes_memory_runtime.json'), document('hermes_memory_runtime', 1, null, {}))
  await assert.rejects(maintain(['extract-v1', '--root', backup, '--out', join(root, 'hermes_memory.json')]), /separate empty/)
  await assert.rejects(access(join(root, 'hermes_memory.json')), { code: 'ENOENT' })
})

test('real DSH JSON units read guarded snapshots and the exported current v1 document', { skip: !process.env.DSH_CLIENT_TEST_CHECKOUT }, async t => {
  const root = await temporary(t)
  const { JsonStorageBackend } = await import(pathToFileURL(join(process.env.DSH_CLIENT_TEST_CHECKOUT, 'packages/storage/storage-json/lib/index.js')))
  const plugin = await mount(root)
  await plugin.call('memory', { target: 'memory', operations: [{ action: 'add', content: 'Native DSH-format synthetic fact' }] })
  await plugin.dispose()
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open({ name: 'hermes_memory', version: 2, compatibleVersions: [1], tables: ['memory', 'user'], hasGlobal: true })
  assert.deepEqual(Object.values((await unit.loadAll()).global.tables.memory).map(row => row.text), ['Native DSH-format synthetic fact'])
  await unit.close()
  await backend.close()
  const backupPath = join(root, 'backup.json')
  await maintain(['export', '--root', root, '--out', backupPath])
  const v1Root = await temporary(t)
  await maintain(['extract-v1', '--root', backupPath, '--out', join(v1Root, 'hermes_memory.json')])
  const legacy = new JsonStorageBackend(v1Root)
  try {
    const unit = await legacy.kv.open({ name: 'hermes_memory', version: 1, tables: ['memory', 'user'], hasGlobal: false })
    assert.deepEqual(Object.values((await unit.loadAll()).tables.memory).map(row => row.text), ['Native DSH-format synthetic fact'])
    await unit.close()
  } finally { await legacy.close() }
})
