import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'
import { projectionFixture, timers, canonicalMemory } from './host-fixture.mjs'

const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT

test('real DSH JSON backend: legacy upgrade, atomic batch, close and reopen preserve both banks', { skip: !checkout }, async t => {
  const { JsonStorageBackend } = await import(pathToFileURL(join(checkout, 'packages/storage/storage-json/lib/index.js')))
  const root = await mkdtemp(join(tmpdir(), 'hermes-memory-storage-'))
  const backend = new JsonStorageBackend(root)
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }) })
  const legacy = await backend.kv.open({ name: 'hermes_memory', version: 1, tables: ['memory', 'user'], hasGlobal: false })
  await legacy.putRecord('memory', 'legacy-memory', { text: 'Legacy synthetic note', seq: 1 })
  await legacy.putRecord('user', 'legacy-user', { text: 'Synthetic user preference', seq: 2 })
  await legacy.close()
  const mount = async () => {
    const tools = new Map()
    const disposers = []
    const projections = projectionFixture()
    const session = projections.session('synthetic')
    await apply({ ...timers,
      sessionProjections: projections.service,
      get: name => name === 'storage' ? { backend: { get: () => backend } } : undefined,
      effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
      on() {},
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    }, { memoryCharLimit: 2200, userCharLimit: 1375, nudgeInterval: 0 })
    return {
      call: (name, args = {}) => tools.get(name).execute(name === 'memory' ? canonicalMemory(args) : args, { agent: { session }, signal: new AbortController().signal }),
      async dispose() { for (const off of disposers.toReversed()) await off() },
    }
  }
  const first = await mount()
  try {
    assert.deepEqual((await first.call('memory_list')).memory, ['Legacy synthetic note'])
    const result = await first.call('memory', { action: 'batch', operations: [{ action: 'remove', oldText: 'Legacy synthetic note' }, { action: 'add', content: 'Atomic synthetic replacement 😀' }] })
    assert.equal(result.success, true)
  } finally { await first.dispose() }
  const unit = await backend.kv.open({ name: 'hermes_memory', version: 2, compatibleVersions: [1], tables: ['memory', 'user'], hasGlobal: true })
  const saved = await unit.loadAll()
  assert.equal(saved.global.format, 2)
  assert.equal(saved.tables.memory['legacy-memory'].text, 'Legacy synthetic note')
  assert.deepEqual(Object.values(saved.global.tables.memory).map(row => row.text), ['Atomic synthetic replacement 😀'])
  assert.deepEqual(Object.values(saved.global.tables.user).map(row => row.text), ['Synthetic user preference'])
  await unit.close()
  assert.ok((await readFile(join(root, 'hermes_memory.json'), 'utf8')).includes('Atomic synthetic replacement'))
  const second = await mount()
  try {
    const listed = await second.call('memory_list')
    assert.deepEqual(listed.memory, ['Atomic synthetic replacement 😀'])
    assert.deepEqual(listed.user, ['Synthetic user preference'])
  } finally { await second.dispose() }
})
