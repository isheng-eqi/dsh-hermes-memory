import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activateHost, projectionFixture, canonicalMemory, timers } from './host-fixture.mjs'

async function mount(t, mode = 'static', config = {}) {
  let saved = { global: null, tables: { memory: {}, user: {} } }
  let runtimeSaved = { global: null, tables: {} }
  const tools = new Map()
  const disposers = []
  const projections = projectionFixture()
  const backend = {
    kv: {
      async open(descriptor) {
        if (descriptor.name === 'hermes_memory_runtime') return {
          loadAll: async () => structuredClone(runtimeSaved),
          async setGlobal(global) { runtimeSaved.global = structuredClone(global) },
          async close() {},
        }
        return {
          loadAll: async () => structuredClone(saved),
          async setGlobal(value) { saved = { ...saved, global: structuredClone(value) } },
          async putRecord(bank, key, value) { saved.tables[bank][key] = structuredClone(value) },
          async deleteRecord(bank, key) { delete saved.tables[bank][key] },
          async close() {},
        }
      },
    },
  }
  const services = {
    storage: { backend: { get: () => backend } },
    connection: { requestRejection: () => undefined },
    webServer: { register: () => () => {} },
  }
  const ctx = {
    ...timers,
    sessionProjections: projections.service,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    get: name => services[name],
    effect(fn) { const off = fn(); if (off) disposers.push(off); return off },
    on: () => () => {},
  }
  await activateHost(mode, ctx, config)
  t.after(async () => {
    for (const off of disposers.toReversed()) await off()
  })
  const signal = new AbortController().signal
  const agent = { session: projections.session() }
  return {
    call: async (name, args = {}) => structuredClone(await tools.get(name).execute(name === 'memory' ? canonicalMemory(args) : args, { signal, agent })),
  }
}

for (const mode of ['static', 'dynamic']) {
  test(`${mode}: memory_search matches ASCII, curly typography, decomposed Unicode, and unspaced CJK queries without duplicate-token inflation`, async t => {
    const h = await mount(t, mode)
    await h.call('memory', { target: 'memory', operations: [
      { action: 'add', content: 'Project uses Node.js — “production” profile.' },
      { action: 'add', content: 'alpha note' },
      { action: 'add', content: 'beta gamma note' },
    ] })
    await h.call('memory', { target: 'user', operations: [
      { action: 'add', content: '用户偏好用中文交流，喜欢简洁回复。' },
      { action: 'add', content: 'Favorite drink: café.' },
    ] })

    const typo = await h.call('memory_search', { query: '"production" - node.js' })
    assert.equal(typo.count, 1)
    assert.equal(typo.results[0].bank, 'memory')
    assert.match(typo.results[0].text, /Node\.js/)

    const nfd = await h.call('memory_search', { query: 'cafe\u0301' })
    assert.equal(nfd.count, 1)
    assert.equal(nfd.results[0].bank, 'user')

    const cjk = await h.call('memory_search', { query: '中文简洁' })
    assert.equal(cjk.count, 1)
    assert.equal(cjk.results[0].bank, 'user')
    assert.match(cjk.results[0].text, /用户偏好用中文交流/)

    const dedup = await h.call('memory_search', { query: 'alpha alpha alpha beta gamma' })
    assert.equal(dedup.results[0].text, 'beta gamma note')
    assert.equal(dedup.results[1].text, 'alpha note')

    const scoped = await h.call('memory_search', { query: 'note', target: 'user' })
    assert.equal(scoped.count, 0)

    const limited = await h.call('memory_search', { query: 'note', limit: 1 })
    assert.equal(limited.count, 1)

    await h.call('memory', { target: 'user', operations: [
      { action: 'add', content: '𠀀𠀂' },
      { action: 'add', content: '𠐁一' },
    ] })
    const supplementaryFalsePositive = await h.call('memory_search', { query: '𠀀𠀁' })
    assert.equal(supplementaryFalsePositive.count, 0)
    const surrogateBoundaryFalsePositive = await h.call('memory_search', { query: '𠀀𠀁一' })
    assert.equal(surrogateBoundaryFalsePositive.count, 0)
  })
}
