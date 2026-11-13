import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apply } from '../lib/index.js'
import { ENTRY_DELIMITER, countChars, renderEntries } from '../lib/core.js'
import { UPSTREAM_COMMIT } from '../lib/prompts.js'
import { projectionFixture, timers } from './host-fixture.mjs'

// No fetch, subprocess, Python installation, Hermes checkout or real user data.
const fixture = JSON.parse(await readFile(new URL('./fixtures/hermes-memory-c0c43577.json', import.meta.url), 'utf8'))
const banks = ['memory', 'user']
const clone = value => structuredClone(value)

// This is the DSH KV medium, not a parser or writer for Hermes Markdown files.
function createMedium(initial = {}) {
  const tables = Object.fromEntries(banks.map(bank => [bank, Object.fromEntries((initial[bank] || []).map((text, index) => [
    `fixture-${index + 1}`, { text, seq: index + 1, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' },
  ]))]))
  let bytes = JSON.stringify({ global: { format: 2, tables }, tables: { memory: {}, user: {} } })
  let writes = 0
  let active = false
  const backend = { kv: { async open(descriptor) {
    assert.equal(descriptor.name, 'hermes_memory', 'this fixture must not open background runtime storage')
    assert.equal(descriptor.version, 2)
    assert.equal(active, false, 'the previous plugin instance must close before reopening')
    active = true
    return {
      loadAll: async () => JSON.parse(bytes),
      async setGlobal(global) {
        const saved = JSON.parse(bytes)
        bytes = JSON.stringify({ ...saved, global: clone(global) })
        writes++
      },
      async close() { active = false },
    }
  } } }
  return { backend, bytes: () => bytes, writes: () => writes }
}

async function mount(t, medium, config = {}) {
  const tools = new Map(), listeners = new Map(), disposers = []
  const projections = projectionFixture()
  const signal = new AbortController().signal
  const session = projections.session('fixture-original')
  await apply({
    ...timers,
    sessionProjections: projections.service,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    get: name => name === 'storage' ? { backend: { get: kind => {
      assert.equal(kind, 'json')
      return medium.backend
    } } } : undefined,
    effect(fn) { const off = fn(); if (off) disposers.push(off); return off },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
  }, { ...config, backgroundReview: { enabled: false } })
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const off of disposers.toReversed()) await off()
  }
  t.after(dispose)
  const call = (name, args = {}) => tools.get(name).execute(args, { agent: { session }, signal })
  const pre = (current = session, turn = 1) => listeners.get('agent/pre-step')(
    { agent: { session: current }, turn, step: 1, signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return { call, pre, session, dispose, newSession: () => projections.session('fixture-new') }
}

const messageText = decision => decision.messages.flatMap(message => message.content.map(block => block.text || '')).join('\n')

async function assertState(h, entries, chars = {}, rendered = {}, limits) {
  const list = await h.call('memory_list')
  for (const bank of banks) {
    assert.deepEqual(list[bank], entries[bank], `${bank} live entries`)
    const text = renderEntries(list[bank])
    if (bank in rendered) assert.equal(text, rendered[bank], `${bank} literal delimiter rendering`)
    const count = countChars(text)
    if (bank in chars) assert.equal(count, chars[bank], `${bank} codepoint budget`)
    const percent = Math.min(100, Math.floor(count / limits[bank] * 100))
    assert.equal(list.usage[bank], `${percent}% — ${count.toLocaleString()}/${limits[bank].toLocaleString()} chars`)
  }
}

test('offline fixture identifies its reviewed baseline and every adapted source', () => {
  assert.equal(fixture.fixtureVersion, 1)
  assert.equal(fixture.upstream.commit, UPSTREAM_COMMIT, 'update fixture and runtime baseline only after explicit upstream review')
  assert.match(fixture.upstream.commit, /^[a-f0-9]{40}$/)
  assert.equal(ENTRY_DELIMITER, fixture.defaults.entryDelimiter)
  const paths = new Set(fixture.upstream.sources.map(source => source.path))
  assert.equal(paths.size, 5)
  assert.ok(paths.has('LICENSE'))
  assert.equal(fixture.upstream.license, 'MIT')
  const ids = new Set()
  for (const scenario of fixture.cases) {
    assert.ok(!ids.has(scenario.id), 'scenario ids must be unique')
    ids.add(scenario.id)
    assert.ok(scenario.adaptation.length > 0)
    assert.ok(scenario.provenance.some(source => source.kind === 'upstream-test'))
    for (const source of scenario.provenance) {
      assert.ok(paths.has(source.path), `unreviewed source path: ${source.path}`)
      assert.ok(source.kind === 'upstream-test' ? source.function : source.kind === 'implementation-derived' && source.symbols.length)
    }
  }
})

for (const scenario of fixture.cases) {
  test(`pinned Hermes subset: ${scenario.id}`, async t => {
    const medium = createMedium(scenario.initial)
    const h = await mount(t, medium, scenario.config)
    const limits = {
      memory: scenario.config?.memoryCharLimit ?? fixture.defaults.memory,
      user: scenario.config?.userCharLimit ?? fixture.defaults.user,
    }
    if (scenario.limits) assert.deepEqual(limits, scenario.limits)
    await assertState(h, scenario.initial || { memory: [], user: [] }, {}, {}, limits)
    let captured, capturedText
    if (scenario.snapshot) {
      captured = await h.pre()
      assert.equal(captured.messages.length, 1)
      capturedText = messageText(captured)
      for (const text of scenario.snapshot.contains) assert.ok(capturedText.includes(text))
      for (const text of scenario.snapshot.excludes) assert.ok(!capturedText.includes(text))
      h.session.append('user/message', captured.messages[0])
    }
    for (const { input, expected } of scenario.calls) {
      const originalInput = clone(input)
      const before = medium.bytes()
      if (expected.errorCode) {
        await assert.rejects(h.call('memory', input), error => error.code === expected.errorCode)
      } else {
        const result = await h.call('memory', input)
        assert.equal(result.success, expected.success)
        if (expected.success) {
          assert.equal(result.target, input.target)
          assert.equal(result.done, true)
        }
      }
      assert.deepEqual(input, originalInput, 'contract validation must not rewrite caller arguments')
      assert.equal(medium.writes(), expected.writes, 'count actual KV commits, not just live state')
      if (!expected.success) assert.equal(medium.bytes(), before, 'rejected batch must leave serialized medium byte-for-byte unchanged')
      await assertState(h, expected.entries, expected.chars, expected.rendered, limits)
    }
    if (scenario.snapshot) {
      assert.equal(messageText(captured), capturedText, 'the admitted original snapshot stays unchanged')
      assert.deepEqual((await h.pre(h.session, 2)).messages, [], 'existing session must not receive a refreshed snapshot')
      const freshText = messageText(await h.pre(h.newSession()))
      for (const text of [...scenario.snapshot.contains, ...scenario.snapshot.excludes]) assert.ok(freshText.includes(text), 'a new session sees committed entries')
    }
    await h.dispose()
    const reopened = await mount(t, medium, scenario.config)
    const final = scenario.calls.at(-1).expected
    await assertState(reopened, final.entries, final.chars, final.rendered, limits)
    assert.equal(medium.writes(), final.writes, 'close/reopen and reads must not create writes')
  })
}
