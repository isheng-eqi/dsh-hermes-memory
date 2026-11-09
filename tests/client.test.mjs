/** Client regressions without a browser, writes to a Host, or new dependencies.
 * Run: node --test tests/client.test.mjs
 * Optional real Cordis/SlotRegistry: set DSH_CLIENT_TEST_CHECKOUT to an existing built DSH checkout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const dynamicSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const list = (memory = ['synthetic entry']) => ({ memory, user: [], usage: { memory: 'test usage', user: 'test usage' } })
const stats = (entries = 1) => ({
  ready: true, memory: { entries, usage: 'test usage' }, user: { entries: 0, usage: 'test usage' }, recent: [], file: 'synthetic store',
})

/** A deterministic hook runner: render/effect/cleanup follow React's relevant lifecycle. */
function hooks() {
  const instances = new Map()
  let current, cursor, pending
  let updatesAfterUnmount = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const instance = current, index = cursor++
      if (!instance.slots[index]) instance.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const state = instance.slots[index]
      return [state.value, (value) => {
        if (!instance.mounted) updatesAfterUnmount++
        state.value = typeof value === 'function' ? value(state.value) : value
      }]
    },
    useRef(initial) {
      const index = cursor++
      return current.slots[index] ||= { current: initial }
    },
    useEffect(effect, deps) {
      const index = cursor++, instance = current, before = instance.slots[index]
      if (!before || !deps || deps.some((value, i) => value !== before.deps[i])) {
        const slot = { deps, cleanup: undefined }
        instance.slots[index] = slot
        pending.push(() => { before?.cleanup?.(); slot.cleanup = effect() })
      }
    },
  }
  return {
    React,
    render(key, component) {
      current = instances.get(key) || { slots: [], mounted: true }
      instances.set(key, current)
      cursor = 0
      pending = []
      const tree = component()
      const effects = pending
      current = undefined
      effects.forEach((effect) => effect())
      return tree
    },
    unmount(key) {
      const instance = instances.get(key)
      instance.slots.forEach((slot) => slot.cleanup?.())
      instance.mounted = false
    },
    get updatesAfterUnmount() { return updatesAfterUnmount },
  }
}
function documentStub() {
  const elements = new Map()
  return {
    elements,
    getElementById: (id) => elements.get(id),
    createElement() { return { remove() { elements.delete(this.id) } } },
    head: { appendChild(node) { elements.set(node.id, node) } },
  }
}
function walk(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => walk(node, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...walk(tree.children || [], predicate)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  return tree && typeof tree === 'object' ? text(tree.children || []) : String(tree ?? '')
}
function button(tree, label) {
  const found = walk(tree, (node) => node.type === 'button' && text(node).includes(label))[0]
  assert.ok(found, `button ${label} exists`)
  return found
}
function fixture(transport, dynamic = false) {
  const runner = hooks(), doc = documentStub(), entries = new Map(), disposers = [], calls = []
  const slots = {
    register(options, component) { const key = options.id || options.key; entries.set(key, component); return () => entries.delete(key) },
    inject(_slot, effect) { const off = effect(); disposers.push(off); return off },
  }
  const invoke = (...args) => { calls.push(args); return transport(...args) }
  let plugin
  if (dynamic) {
    plugin = vm.runInNewContext(`(function () { ${dynamicSource}\n})()`, { React: runner.React, host: { call: invoke } })
  } else {
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => runner.React) } } },
      document: doc, fetch: invoke,
    })
  }
  plugin.apply({ get: () => slots, effect(fn) { const off = fn(); disposers.push(off); return off } })
  const render = () => runner.render('view', entries.get(dynamic ? 'self' : 'hermes-memory-panel'))
  return {
    plugin, calls, doc, runner, render,
    show() {
      render()
      const entry = runner.render('entry', entries.get('hermes-memory'))
      entry.props.onClick()
      return render()
    },
    close() { button(render(), '×').props.onClick(); render() },
    reopen() { runner.render('entry', entries.get('hermes-memory')).props.onClick(); return render() },
    dispose() { runner.unmount('view'); disposers.reverse().forEach((off) => off?.()) },
  }
}
function section(tree, bank = 'memory') {
  const node = walk(tree, (node) => typeof node.type === 'function' && node.props.bank === bank)[0]
  assert.ok(node, `section ${bank} exists`)
  return node.props
}

// Synthetic payloads only: tests never connect to a real service or expose memory contents.
test('static: slots dependency and owned stylesheet cleanup', () => {
  const h = fixture(async () => response(list()))
  assert.equal(h.plugin.inject.join(','), 'slots')
  assert.equal(h.doc.elements.size, 1)
  h.show()
  h.dispose()
  assert.equal(h.doc.elements.size, 0)
})

test('static: loading is not an empty bank; only a valid response shows empty banks', async () => {
  const answer = deferred(), h = fixture(() => answer.promise)
  h.show()
  let tree = h.render() // Effect setLoading triggers the next React render.
  assert.match(text(tree), /载入中/)
  assert.equal(walk(tree, (node) => typeof node.type === 'function').length, 0)
  answer.resolve(response(list([])))
  await tick()
  tree = h.render()
  assert.equal(section(tree).list.length, 0)
  assert.equal(section(tree, 'user').list.length, 0)
})

for (const [name, value] of [
  ['HTTP 500 JSON', response({ success: false, error: 'synthetic unavailable' }, 500)],
  ['business failure', response({ success: false, error: 'synthetic unavailable' })],
  ['not ready', response({ ready: false, error: 'synthetic unavailable' })],
  ['malformed list', response({ memory: {}, user: [], usage: {} })],
  ['null JSON', response(null)],
  ['HTTP 401 non-JSON', { ok: false, status: 401, json: async () => { throw new Error('not JSON') } }],
]) {
  test(`static: ${name} is visible and retryable, never a successful empty bank`, async () => {
    let attempt = 0
    const h = fixture(async () => attempt++ === 0 ? value : response(list()))
    h.show()
    await tick()
    let tree = h.render()
    assert.match(text(tree), /载入失败/)
    assert.equal(walk(tree, (node) => typeof node.type === 'function').length, 0)
    button(tree, '重试载入').props.onClick()
    await tick()
    tree = h.render()
    assert.equal(section(tree).list[0], 'synthetic entry')
  })
}

test('static: failed add/edit retain the draft and editor; successful retry clears them', async () => {
  let succeed = false
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response(list()) : response(succeed ? { success: true } : { success: false, error: 'synthetic capacity failure' }))
  h.show()
  await tick()
  section(h.render()).onDraft('unsaved synthetic draft')
  section(h.render()).onAdd()
  assert.equal(section(h.render()).draft, 'unsaved synthetic draft')
  await tick()
  assert.equal(section(h.render()).draft, 'unsaved synthetic draft')
  assert.match(text(h.render()), /synthetic capacity failure/)
  section(h.render()).onEdit({ bank: 'memory', index: 0, text: 'synthetic edited', original: 'synthetic entry' })
  section(h.render()).onSave()
  await tick()
  assert.equal(section(h.render()).editing.text, 'synthetic edited')
  succeed = true
  section(h.render()).onSave()
  await tick()
  assert.equal(section(h.render()).editing, null)
  section(h.render()).onAdd()
  await tick()
  assert.equal(section(h.render()).draft, '')
})

test('static: a retained Enter/click handler cannot duplicate an in-flight mutation', async () => {
  const write = deferred()
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list' ? response(list()) : write.promise)
  h.show()
  await tick()
  section(h.render()).onDraft('synthetic duplicate guard')
  const onAdd = section(h.render()).onAdd
  onAdd(); onAdd()
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'add').length, 1)
  const props = section(h.render())
  const component = walk(h.render(), (node) => typeof node.type === 'function' && node.props.bank === 'memory')[0].type
  const input = walk(component(props), (node) => node.type === 'input')[0]
  assert.equal(input.props.disabled, true)
  input.props.onKeyDown({ key: 'Enter' })
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'add').length, 1)
  write.resolve(response({ success: true }))
  await tick()
})

test('static: a committed write followed by failed reload is not retried as another write', async () => {
  let lists = 0
  const h = fixture(async (_path, init) => {
    if (JSON.parse(init.body).action !== 'list') return response({ success: true })
    return ++lists === 2 ? response({ error: 'synthetic reload failure' }, 500) : response(list())
  })
  h.show()
  await tick()
  section(h.render()).onDraft('synthetic committed')
  section(h.render()).onAdd()
  await tick()
  const tree = h.render()
  assert.equal(section(tree).draft, '')
  assert.match(text(tree), /已添加；重新载入失败/)
  assert.equal(section(tree).list[0], 'synthetic entry')
  button(tree, '重试载入').props.onClick()
  await tick()
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'add').length, 1)
})

test('static: close/reopen invalidates older loads; unmount ignores pending completions', async () => {
  const pending = []
  const h = fixture(() => { const answer = deferred(); pending.push(answer); return answer.promise })
  h.show(); h.close(); h.reopen()
  pending[1].resolve(response(list(['synthetic newer'])))
  await tick()
  pending[0].resolve(response(list(['synthetic stale'])))
  await tick()
  assert.equal(section(h.render()).list[0], 'synthetic newer')
  button(h.render(), '刷新').props.onClick()
  h.dispose()
  pending[2].resolve(response(list(['synthetic after unmount'])))
  await tick()
  assert.equal(h.runner.updatesAfterUnmount, 0)
})

test('static: an unmounted pending write does not update or reload the disposed panel', async () => {
  const pending = deferred()
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list' ? response(list()) : pending.promise)
  h.show()
  await tick()
  section(h.render()).onDraft('synthetic disposed write')
  section(h.render()).onAdd()
  h.dispose()
  pending.resolve(response({ success: true }))
  await tick()
  assert.equal(h.runner.updatesAfterUnmount, 0)
  assert.equal(h.calls.length, 2)
})

test('dynamic: transport rejection is shown without losing the last successful card', async () => {
  let attempts = 0
  const h = fixture(async () => {
    if (++attempts === 2) throw new Error('synthetic connection failure')
    return stats(4)
  }, true)
  h.render()
  await tick()
  button(h.render(), 'Refresh').props.onClick()
  await tick()
  const tree = h.render()
  assert.match(text(tree), /synthetic connection failure/)
  assert.match(text(tree), /4 entries/)
  assert.equal(button(tree, 'Retry').props.disabled, false)
})

test('dynamic: validates RPC payloads, displays retry, and retains the last valid statistics', async () => {
  const values = [null, { ready: false, error: 'synthetic not ready' }, { ready: true }, stats(7), { ...stats(), recent: [{}] }]
  const h = fixture(async () => values.shift(), true)
  assert.equal(h.plugin.inject.join(','), 'slots')
  h.render()
  await tick()
  for (let i = 0; i < 3; i++) {
    const tree = h.render()
    assert.match(text(tree), /Error:/)
    button(tree, 'Retry').props.onClick()
    await tick()
  }
  let tree = h.render()
  assert.match(text(tree), /7 entries/)
  button(tree, 'Refresh').props.onClick()
  await tick()
  tree = h.render()
  assert.match(text(tree), /Error: Invalid memory statistics response/)
  assert.match(text(tree), /7 entries/)
})

test('dynamic: newest RPC wins and an unloaded card receives no state updates', async () => {
  const answers = []
  const h = fixture(() => { const value = deferred(); answers.push(value); return value.promise }, true)
  const first = h.render()
  button(first, 'Refresh').props.onClick()
  answers[1].resolve(stats(8))
  await tick()
  answers[0].resolve(stats(3))
  await tick()
  assert.match(text(h.render()), /8 entries/)
  button(h.render(), 'Refresh').props.onClick()
  h.dispose()
  answers[2].resolve(stats(9))
  await tick()
  assert.equal(h.runner.updatesAfterUnmount, 0)
})

const checkout = process.env.DSH_CLIENT_TEST_CHECKOUT
test('real DSH: declaration gate, owner reload, plugin unload and CSS cleanup', { skip: !checkout }, async () => {
  const require = createRequire(join(checkout, 'packages/client/ui-renderer/package.json'))
  const { Context } = require('@deepseek-ai/cordis')
  let renderer
  vm.runInNewContext(readFileSync(join(checkout, 'packages/client/ui-renderer/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(registration) { renderer = registration.factory(require) } } }, console,
  })
  const ctx = new Context(), doc = documentStub()
  let plugin
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(require) } } }, document: doc,
  })
  // A missing renderer must park the plugin, not silently run apply once.
  const mounted = ctx.plugin(plugin)
  await mounted
  assert.equal(doc.elements.size, 0)
  const serviceFiber = ctx.plugin(renderer.SlotRegistry)
  await serviceFiber
  await tick()
  const slots = ctx.get('slots')
  assert.throws(() => slots.register({ name: 'sidebar.footer.action', id: 'ungated' }, () => null), /not declared/)
  const counts = () => ['sidebar.footer.action', 'shell.overlay'].map((name) => slots.entriesOfSlot(name).length)
  const declare = () => slots.register({ name: 'root', children: {
    'sidebar.footer.action': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, () => null)
  assert.deepEqual(counts(), [0, 0])
  let owner = declare()
  await tick()
  assert.deepEqual(counts(), [1, 1])
  owner()
  await tick()
  assert.deepEqual(counts(), [0, 0])
  owner = declare()
  await tick()
  assert.deepEqual(counts(), [1, 1])
  assert.equal(doc.elements.size, 1)
  await mounted.dispose()
  assert.deepEqual(counts(), [0, 0])
  assert.equal(doc.elements.size, 0)
  owner()
  await serviceFiber.dispose()
})
