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
    render(key, component, commit) {
      current = instances.get(key) || { slots: [], mounted: true }
      current.mounted = true
      instances.set(key, current)
      cursor = 0
      pending = []
      const tree = component()
      const effects = pending
      current = undefined
      commit?.(tree)
      effects.forEach((effect) => effect())
      return tree
    },
    unmount(key) {
      const instance = instances.get(key)
      if (!instance) return
      instance.slots.forEach((slot) => slot.cleanup?.())
      instance.mounted = false
      instances.delete(key)
    },
    get updatesAfterUnmount() { return updatesAfterUnmount },
  }
}
function documentStub() {
  const elements = new Map(), listeners = new Map(), roots = new Map()
  const doc = {
    elements,
    activeElement: null,
    getElementById: (id) => elements.get(id),
    createElement() { return { remove() { elements.delete(this.id) } } },
    head: { appendChild(node) { elements.set(node.id, node) } },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler) },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler) },
    dispatch(type, init = {}) {
      const event = { ...init, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
      for (const handler of listeners.get(type) || []) handler(event)
      return event
    },
    listenerCount(type) { return listeners.get(type)?.size || 0 },
    commit(key, tree) {
      const previous = roots.get(key) || new Map(), next = new Map()
      const build = (value, path) => {
        if (Array.isArray(value)) return value.flatMap((item, i) => build(item, `${path}.${i}`))
        if (!value || typeof value !== 'object') return []
        if (typeof value.type === 'function') return build(value.type(value.props), `${path}.component`)
        if (typeof value.type !== 'string') return build(value.children || [], path)
        const node = previous.get(path) || {}
        Object.assign(node, { type: value.type, props: value.props, disabled: !!value.props.disabled, hidden: !!value.props.hidden, isConnected: true,
          tabIndex: value.props.tabIndex ?? (['button', 'input', 'textarea', 'select'].includes(value.type) || value.props.href ? 0 : -1),
          focus() { doc.activeElement = this }, getAttribute(name) { return this.props[name] ?? null },
          contains(target) { return target === this || this.children.some(child => child.contains(target)) },
          querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => ['button', 'input', 'textarea', 'select'].includes(child.type) || child.props.href || child.props.tabIndex !== undefined) },
        })
        next.set(path, node)
        node.children = build(value.children || [], `${path}.children`)
        value.dom = node
        if (value.props.ref) value.props.ref.current = node
        return [node]
      }
      build(tree, 'root')
      for (const [path, node] of previous) if (!next.has(path)) node.isConnected = false
      roots.set(key, next)
    },
    disconnect(key) { for (const node of roots.get(key)?.values() || []) node.isConnected = false; roots.delete(key) },
  }
  return doc
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
/** Synthetic DSH locale service: the active id, change subscription and listener count. */
function localeService(active) {
  const listeners = new Set()
  return {
    listeners,
    getLocale: () => ({ active, locales: [], revision: 0 }),
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    switchTo(next) { active = next; for (const fn of [...listeners]) fn() },
  }
}
/** Every visible string and labelled attribute, for "no untranslated text" checks. */
function visibleStrings(tree) {
  return walk(tree, () => true).flatMap(node => [
    ...(node.children || []).filter(child => typeof child === 'string' || typeof child === 'number').map(String),
    ...['aria-label', 'placeholder', 'title'].map(name => node.props?.[name]).filter(value => typeof value === 'string'),
  ])
}
const HAN = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

function fixture(transport, dynamic = false, services = {}) {
  const runner = hooks(), doc = documentStub(), entries = new Map(), disposers = [], calls = [], copied = []
  const keyOf = (options) => options.name === 'main' ? `main:${options.key}`
    : options.name === 'sidebar.panellist' ? `panellist:${options.id}`
      : options.id || options.key
  const slots = {
    register(options, component) { const key = keyOf(options); entries.set(key, component); return () => entries.delete(key) },
    inject(_slot, effect) { const off = effect(); disposers.push(off); return off },
  }
  const invoke = (...args) => { calls.push(args); return transport(...args) }
  let plugin
  if (dynamic) {
    plugin = vm.runInNewContext(`(function () { ${dynamicSource}\n})()`, { React: runner.React, host: { call: invoke } })
  } else {
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => runner.React) } } },
      document: doc, fetch: invoke, navigator: { clipboard: { async writeText(value) { copied.push(value) } } },
    })
  }
  plugin.apply({ get: (name) => name === 'slots' ? slots : services[name], effect(fn) { const off = fn(); disposers.push(off); return off } })
  const render = () => runner.render('view', entries.get(dynamic ? 'self' : 'main:hermes-memory'), tree => doc.commit('view', tree))
  const close = () => { runner.unmount('view'); doc.disconnect('view') }
  return {
    plugin, calls, doc, runner, entries, render, copied,
    show() { return render() },
    close,
    reopen() { return render() },
    dispose() { close(); disposers.reverse().forEach((off) => off?.()) },
  }
}
function section(tree, bank = 'memory') {
  const node = walk(tree, (node) => typeof node.type === 'function' && node.props.bank === bank)[0]
  assert.ok(node, `section ${bank} exists`)
  return node.props
}
function sectionView(tree, bank = 'memory') {
  const node = walk(tree, (node) => typeof node.type === 'function' && node.props.bank === bank)[0]
  assert.ok(node, `section ${bank} exists`)
  return node.type(node.props)
}

// Synthetic payloads only: tests never connect to a real service or expose memory contents.
test('static: registers a global main panel and sidebar panellist, not the old overlay', () => {
  const h = fixture(async () => response(list()))
  assert.ok(h.entries.has('main:hermes-memory'))
  assert.ok(h.entries.has('panellist:hermes-memory'))
  assert.equal([...h.entries.keys()].some(key => key.includes('sidebar.footer.action')), false)
  assert.equal([...h.entries.keys()].some(key => key.includes('shell.overlay')), false)
  h.dispose()
})

test('static: slots dependency and owned stylesheet cleanup', () => {
  const h = fixture(async () => response(list()))
  assert.equal(h.plugin.inject.join(','), 'slots')
  assert.equal(h.doc.elements.size, 1)
  h.show()
  h.dispose()
  assert.equal(h.doc.elements.size, 0)
})

test('static: an add draft survives leaving and returning to the global page', async () => {
  const h = fixture(async () => response(list()))
  h.show()
  await tick()
  section(h.render()).onDraft('kept synthetic draft')
  h.close()
  h.reopen()
  await tick()
  assert.equal(section(h.render()).draft, 'kept synthetic draft')
  h.dispose()
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

test('static: review status and pending approvals remain explicit and serialize user actions', async () => {
  const write = deferred()
  const payload = { ...list(), backgroundReview: { enabled: true, interval: 10, status: 'completed' },
    pending: [{ id: 'synthetic-pending', target: 'user', operations: [{ action: 'patch', oldText: 'old synthetic preference', content: 'new synthetic preference' }] }] }
  const h = fixture(async (path, init) => path === '/hermes-memory/pending' ? write.promise : response(payload))
  h.show()
  await tick()
  let tree = h.render()
  assert.match(text(tree), /每 10 轮用户对话/)
  assert.match(text(tree), /待审修改 · 1/)
  assert.match(text(tree), /old synthetic preference/)
  assert.match(text(tree), /new synthetic preference/)
  const approve = button(tree, '批准').props.onClick
  approve(); approve()
  assert.equal(h.calls.filter(([path]) => path === '/hermes-memory/pending').length, 1)
  assert.deepEqual(JSON.parse(h.calls.at(-1)[1].body), { action: 'approve', id: 'synthetic-pending' })
  write.resolve(response({ success: false, error: 'Synthetic original entry changed' }))
  await tick()
  tree = h.render()
  assert.match(text(tree), /Synthetic original entry changed/)
  assert.match(text(tree), /待审修改 · 1/)
  assert.equal(button(tree, '批准').props.disabled, false)
})

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

test('static: another row or bank cannot replace an active draft before save or cancel', async () => {
  const h = fixture(async () => response({ ...list(['first entry', 'second entry']), user: ['user entry'] }))
  h.show()
  await tick()
  const before = section(h.render())
  before.onEdit({ bank: 'memory', index: 0, text: 'unsaved draft', original: 'first entry' })
  // Even a click handler retained from the previous render cannot switch rows.
  before.onEdit({ bank: 'memory', index: 1, text: 'second entry', original: 'second entry' })
  section(h.render(), 'user').onEdit({ bank: 'user', index: 0, text: 'user entry', original: 'user entry' })
  assert.equal(section(h.render()).editing.text, 'unsaved draft')
  for (const bank of ['memory', 'user']) {
    const view = sectionView(h.render(), bank)
    for (const action of walk(view, (node) => node.type === 'button' && ['编辑', '删除'].includes(text(node)))) {
      assert.equal(action.props.disabled, true)
    }
  }
  const view = sectionView(h.render())
  walk(view, (node) => node.type === 'textarea')[0].props.onChange({ target: { value: 'updated draft' } })
  assert.equal(section(h.render()).editing.text, 'updated draft')
  section(h.render()).onCancel()
  section(h.render()).onEdit({ bank: 'memory', index: 1, text: 'second entry', original: 'second entry' })
  assert.equal(section(h.render()).editing.original, 'second entry')
})

test('static: failed saves show beside the editor and only Save retries the mutation', async () => {
  let succeeds = false
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response(list()) : response(succeeds ? { success: true } : { error: 'synthetic save failure' }, succeeds ? 200 : 422))
  h.show()
  await tick()
  section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'changed draft' })
  section(h.render()).onSave()
  await tick()
  let tree = h.render()
  assert.match(text(sectionView(tree)), /保存失败：synthetic save failure/)
  assert.doesNotMatch(text(tree), /synthetic save failure|重试载入/)
  button(tree, '刷新').props.onClick()
  await tick()
  tree = h.render()
  assert.equal(section(tree).editing.text, 'changed draft')
  assert.match(text(sectionView(tree)), /synthetic save failure/)
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'replace').length, 1)
  succeeds = true
  section(tree).onSave()
  await tick()
  assert.equal(section(h.render()).editing, null)
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'replace').length, 2)
})

test('static: refresh keeps the editor on its original entry and preserves missing-entry drafts', async () => {
  let entries = ['first entry', 'second entry']
  const h = fixture(async () => response(list(entries)))
  h.show()
  await tick()
  section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'first entry', text: 'retained draft' })
  entries = ['second entry', 'first entry']
  button(h.render(), '刷新').props.onClick()
  await tick()
  let rows = walk(sectionView(h.render()), (node) => node.props.className === 'hm-row')
  assert.equal(walk(rows[0], (node) => node.type === 'textarea').length, 0)
  assert.equal(walk(rows[1], (node) => node.type === 'textarea')[0].props.value, 'retained draft')
  entries = ['second entry']
  button(h.render(), '刷新').props.onClick()
  await tick()
  let view = sectionView(h.render())
  assert.match(text(view), /原条目已变化或被删除/)
  assert.equal(walk(view, (node) => node.type === 'textarea')[0].props.value, 'retained draft')
  h.dispose()
})

test('static: deletion requires inline confirmation of the full original text', async () => {
  const write = deferred()
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list' ? response(list()) : write.promise)
  h.show()
  await tick()
  section(h.render()).onRemove('memory', 'synthetic entry')
  assert.equal(h.calls.length, 1)
  let view = sectionView(h.render())
  assert.match(text(view), /确认删除以下记忆？ synthetic entry/)
  button(view, '取消删除').props.onClick()
  assert.equal(section(h.render()).deleting, null)
  assert.equal(h.calls.length, 1)
  section(h.render()).onRemove('memory', 'synthetic entry')
  const confirm = button(sectionView(h.render()), '确认删除').props.onClick
  confirm(); confirm()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(JSON.parse(h.calls[1][1].body), { action: 'remove', bank: 'memory', oldText: 'synthetic entry' })
  assert.equal(button(sectionView(h.render()), '取消删除').props.disabled, true)
  write.resolve(response({ success: true }))
  await tick()
  assert.equal(section(h.render()).deleting, null)
})

test('static: a stale delete keeps its confirmation and error without changing the target', async () => {
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response(list()) : response({ error: 'entry changed; refresh the list' }, 422))
  h.show()
  await tick()
  section(h.render()).onRemove('memory', 'synthetic entry')
  section(h.render()).onConfirmRemove()
  await tick()
  let view = sectionView(h.render())
  assert.match(text(view), /删除失败：entry changed; refresh the list/)
  assert.equal(section(h.render()).deleting.text, 'synthetic entry')
  assert.doesNotMatch(text(h.render()), /重试载入/)
  button(h.render(), '刷新').props.onClick()
  await tick()
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'remove').length, 1)
  button(sectionView(h.render()), '取消删除').props.onClick()
  assert.equal(section(h.render()).deleting, null)
})

test('static: refresh never blesses a stale draft or delete confirmation with a fresh row version', async () => {
  for (const action of ['replace', 'remove']) {
    let version = 'epoch:first'
    const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
      ? response({ ...list(), entryVersions: { memory: [version], user: [] } }) : response({ success: true }))
    h.show()
    await tick()
    if (action === 'replace') section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'retained draft' })
    else section(h.render()).onRemove('memory', 'synthetic entry')
    const staleHandler = action === 'replace' ? section(h.render()).onSave : section(h.render()).onConfirmRemove
    version = 'epoch:replacement'
    button(h.render(), '刷新').props.onClick()
    await tick()
    const props = section(h.render())
    if (action === 'replace') {
      assert.match(text(sectionView(h.render())), /原条目已变化或被删除/)
      assert.equal(props.editing.expectedVersion, 'epoch:first')
      section(h.render()).onEdit({ ...props.editing, text: 'retained edited draft' })
      assert.equal(button(sectionView(h.render()), '保存').props.disabled, true)
      staleHandler(); section(h.render()).onSave()
      await section(h.render()).onCopy()
      assert.equal(h.copied[0], 'retained edited draft')
      assert.match(text(sectionView(h.render())), /草稿已复制.*取消.*刷新列表/)
      section(h.render()).onCancel()
      section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'fresh draft' })
    } else {
      assert.equal(props.deleting.expectedVersion, 'epoch:first')
      assert.equal(button(sectionView(h.render()), '确认删除').props.disabled, true)
      staleHandler(); props.onConfirmRemove()
      props.onCancelRemove()
      section(h.render()).onRemove('memory', 'synthetic entry')
    }
    assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === action).length, 0)
    if (action === 'replace') section(h.render()).onSave()
    else section(h.render()).onConfirmRemove()
    await tick()
    const writes = h.calls.map(([, init]) => JSON.parse(init.body)).filter(body => body.action === action)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].expectedVersion, 'epoch:replacement')
    h.dispose()
  }
})

test('static: deleting a duplicate row captures that specific row index version', async () => {
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response({ ...list(['duplicate entry', 'duplicate entry']), entryVersions: { memory: ['v:row-0', 'v:row-1'], user: [] } })
    : response({ success: true }))
  h.show()
  await tick()
  const rows = walk(sectionView(h.render()), node => node.props.className === 'hm-row')
  button(rows[1], '删除').props.onClick()
  section(h.render()).onConfirmRemove()
  await tick()
  const removes = h.calls.map(([, init]) => JSON.parse(init.body)).filter(body => body.action === 'remove')
  assert.equal(removes.length, 1)
  assert.equal(removes[0].expectedVersion, 'v:row-1')
  h.dispose()
})

test('static: invalid or mismatched row versions are rejected without showing an editable list', async () => {
  for (const entryVersions of [null, [], { memory: [], user: [] }, { memory: [null], user: [] }, { memory: [''], user: [] }]) {
    const h = fixture(async () => response({ ...list(), entryVersions }))
    h.show()
    await tick()
    assert.match(text(h.render()), /无效记忆版本/)
    assert.equal(walk(h.render(), node => typeof node.type === 'function' && node.props.bank).length, 0)
    h.dispose()
  }
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

test('static: export is an owner download and history compaction requires confirmation and serializes requests', async () => {
  const pending = deferred()
  const h = fixture(async (path) => path === '/hermes-memory/compact' ? pending.promise : response(list()))
  h.show()
  await tick()
  let tree = h.render()
  const link = walk(tree, node => node.type === 'a' && text(node).includes('导出备份'))[0]
  assert.equal(link.props.href, '/hermes-memory/export')
  assert.equal(link.props.download, 'hermes-memory-export.json')
  button(tree, '压缩历史详情').props.onClick()
  assert.equal(h.calls.length, 1, 'opening confirmation must not compact')
  tree = h.render()
  assert.match(text(tree), /30 天.*100 条/)
  assert.match(text(tree), /结果不明/)
  button(tree, '取消').props.onClick()
  assert.equal(h.calls.length, 1)
  button(h.render(), '压缩历史详情').props.onClick()
  tree = h.render()
  const confirm = button(tree, '确认压缩').props.onClick
  confirm(); confirm()
  const requests = h.calls.filter(([path]) => path === '/hermes-memory/compact')
  assert.equal(requests.length, 1)
  const body = JSON.parse(requests[0][1].body)
  assert.equal(body.maxDetailed, 100)
  assert.ok(Math.abs(Date.parse(body.before) - (Date.now() - 30 * 86400000)) < 1000)
  pending.resolve(response({ success: true }))
  await tick()
  assert.equal(walk(h.render(), node => node.props['aria-label'] === '确认压缩历史详情').length, 0)
  h.dispose()
})

for (const status of [401, 403]) {
  test(`static: non-JSON HTTP ${status} keeps authentication meaning and has no futile retry`, async () => {
    const h = fixture(async () => ({ ok: false, status, json: async () => { throw new Error('synthetic HTML login response') } }))
    h.show()
    await tick()
    const tree = h.render()
    assert.match(text(tree), status === 401 ? /登录已过期.*重新登录/ : /没有操作权限.*重新登录/)
    assert.doesNotMatch(text(tree), /非 JSON|请重试|重试载入/)
    assert.equal(walk(tree, node => node.type === 'button' && /刷新|重试/.test(text(node))).length, 0)
    assert.equal(h.calls.length, 1)
    h.dispose()
  })
}

test('static: first poisoned write immediately blocks all writes, preserves drafts, and offers no reload retry', async () => {
  const poisoned = { mode: 'guarded-native', state: 'poisoned', code: 'storage_reload_required', error: 'synthetic external change' }
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response({ ...list(), storageSafety: { mode: 'guarded-native', state: 'open' } })
    : response({ success: false, code: 'storage_reload_required', error: 'synthetic external change', storageSafety: poisoned }, 503))
  h.show()
  await tick()
  section(h.render()).onDraft('retained add draft')
  section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'retained edit draft' })
  const staleSave = section(h.render()).onSave, staleRefresh = button(h.render(), '刷新').props.onClick
  staleSave()
  await tick()
  const tree = h.render(), props = section(tree), view = sectionView(tree)
  assert.match(text(tree), /存储保护已触发.*写入已暂停/)
  assert.equal(props.editError.status, 503)
  assert.equal(props.editError.code, 'storage_reload_required')
  assert.equal(props.editing.text, 'retained edit draft')
  assert.equal(props.draft, 'retained add draft')
  assert.equal(props.list[0], 'synthetic entry')
  assert.equal(button(view, '保存').props.disabled, true)
  assert.equal(button(view, '取消').props.disabled, false)
  assert.equal(button(view, '添加').props.disabled, true)
  assert.equal(walk(tree, node => node.type === 'button' && /刷新|重试/.test(text(node))).length, 0)
  staleSave(); staleRefresh(); props.onAdd()
  await tick()
  assert.equal(h.calls.length, 2, 'neither mutation nor load is automatically replayed')
  h.dispose()
})

test('static: poisoned subsequent list retains last good rows and drafts, host JSON limitations stay visible', async () => {
  let loads = 0
  const h = fixture(async () => ++loads === 1
    ? response({ ...list(), storageSafety: { mode: 'host-json', state: 'open', crossProcessLock: false, externalChangeCheck: false } })
    : response({ ready: false, code: 'storage_reload_required', error: 'synthetic poisoned load', storageSafety: { mode: 'guarded-native', state: 'poisoned' } }, 503))
  h.show()
  await tick()
  assert.match(text(h.render()), /宿主 JSON.*跨进程写锁.*外部变更检查/)
  section(h.render()).onDraft('retained list draft')
  button(h.render(), '刷新').props.onClick()
  await tick()
  const tree = h.render()
  assert.equal(section(tree).list[0], 'synthetic entry')
  assert.equal(section(tree).draft, 'retained list draft')
  assert.equal(section(tree).writesBlocked, true)
  assert.match(text(tree), /存储保护已触发/)
  assert.doesNotMatch(text(tree), /重试载入|可重试/)
  h.dispose()
})

for (const code of ['runtime_reload_required', 'unauthorized', 'forbidden']) {
  test(`static: ${code} write errors block stale handlers and preserve local editor`, async () => {
    const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list' ? response(list())
      : response({ success: false, code, error: 'synthetic terminal error' }, code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : 503))
    h.show()
    await tick()
    section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'terminal draft' })
    const save = section(h.render()).onSave
    save()
    await tick()
    save()
    assert.equal(h.calls.length, 2)
    assert.equal(section(h.render()).editError.code, code)
    assert.equal(section(h.render()).editing.text, 'terminal draft')
    assert.equal(button(sectionView(h.render()), '保存').props.disabled, true)
    assert.equal(walk(h.render(), node => node.type === 'button' && /刷新|重试/.test(text(node))).length, 0)
    h.dispose()
  })
}

test('static: retryable storage unavailable uses a read recovery, never replays the failed write', async () => {
  let available = false
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response({ ...list(), storageSafety: { mode: 'guarded-native', state: 'open' } })
    : available ? response({ success: true }) : response({ success: false, code: 'storage_unavailable', retryable: true,
      error: 'synthetic temporarily unavailable', storageSafety: { mode: 'guarded-native', state: 'unavailable' } }, 503))
  h.show()
  await tick()
  section(h.render()).onDraft('retained temporary draft')
  section(h.render()).onAdd()
  await tick()
  assert.equal(section(h.render()).writesBlocked, true)
  assert.equal(section(h.render()).draft, 'retained temporary draft')
  button(h.render(), '刷新').props.onClick()
  await tick()
  assert.equal(section(h.render()).writesBlocked, false)
  assert.equal(h.calls.filter(([, init]) => JSON.parse(init.body).action === 'add').length, 1)
  available = true
  section(h.render()).onAdd()
  await tick()
  assert.equal(section(h.render()).draft, '')
  h.dispose()
})

for (const action of ['replace', 'remove']) {
  test(`static: structured ${action} conflict disables stale resubmission until explicit cancel/reselect`, async () => {
    let version = 'v:old', writes = 0
    const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
      ? response({ ...list(), entryVersions: { memory: [version], user: [] } })
      : ++writes === 1 ? response({ success: false, code: 'row_conflict', conflict: true, error: 'synthetic row conflict' }, 409)
        : response({ success: true }))
    h.show()
    await tick()
    const start = () => action === 'replace'
      ? section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'conflicting draft' })
      : section(h.render()).onRemove('memory', 'synthetic entry', 0)
    const submit = () => action === 'replace' ? section(h.render()).onSave : section(h.render()).onConfirmRemove
    start()
    const staleSubmit = submit()
    staleSubmit()
    await tick()
    const failure = action === 'replace' ? section(h.render()).editError : section(h.render()).deleteError
    assert.equal(failure.status, 409)
    assert.equal(failure.code, 'row_conflict')
    assert.equal(button(sectionView(h.render()), action === 'replace' ? '保存' : '确认删除').props.disabled, true)
    staleSubmit(); submit()()
    assert.equal(writes, 1)
    version = 'v:current'
    button(h.render(), '刷新').props.onClick()
    await tick()
    staleSubmit(); submit()()
    assert.equal(writes, 1)
    if (action === 'replace') {
      assert.equal(section(h.render()).editing.text, 'conflicting draft')
      await section(h.render()).onCopy()
      assert.equal(h.copied[0], 'conflicting draft')
      section(h.render()).onCancel()
    } else section(h.render()).onCancelRemove()
    start(); submit()()
    await tick()
    const requests = h.calls.map(([, init]) => JSON.parse(init.body)).filter(body => body.action === action)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].expectedVersion, 'v:old')
    assert.equal(requests[1].expectedVersion, 'v:current')
    h.dispose()
  })
}

test('static: accessible row names, codepoint excerpts, contrast, wrapping and page semantics', async () => {
  const entry = '😀'.repeat(33)
  const h = fixture(async () => response({ ...list([entry, entry]), user: [entry] }))
  h.show()
  await tick()
  const tree = h.render()
  assert.equal(walk(tree, node => node.props.role === 'dialog').length, 0)
  assert.equal(walk(tree, node => node.props.className === 'hm-page').length, 1)
  assert.equal(h.doc.listenerCount('keydown'), 0)
  const view = sectionView(tree), actions = walk(view, node => node.props.className === 'hm-action')
  assert.equal(actions[0].props['aria-label'], `编辑 MEMORY 第 1 条：${'😀'.repeat(32)}…`)
  assert.notEqual(actions[0].props['aria-label'], actions[2].props['aria-label'])
  assert.notEqual(actions[0].props['aria-label'], walk(sectionView(tree, 'user'), node => node.props.className === 'hm-action')[0].props['aria-label'])
  for (const action of actions) {
    assert.equal(action.props.style.color, 'var(--dsw-alias-label-secondary)')
    assert.equal(action.props.style.opacity, 1)
    assert.ok(action.props.style.minWidth >= 24 && action.props.style.minHeight >= 24)
  }
  const entryText = walk(view, node => node.type === 'span' && text(node) === entry)[0]
  assert.equal(entryText.props.style.wordBreak, 'normal')
  assert.equal(entryText.props.style.overflowWrap, 'anywhere')
  assert.equal(walk(view, node => node.type === 'input')[0].props['aria-label'], '添加 MEMORY 记忆条目')
  assert.match(h.doc.elements.values().next().value.textContent, /focus-visible.*outline: 2px solid/)
  h.dispose()
})

test('static: global page renders without a modal shell or keydown interception', async () => {
  const h = fixture(async () => response(list()))
  h.show()
  await tick()
  let tree = h.render()
  assert.equal(walk(tree, node => node.props.role === 'dialog').length, 0)
  assert.equal(walk(tree, node => node.props.className === 'hm-page').length, 1)
  assert.equal(h.doc.listenerCount('keydown'), 0)
  assert.ok(button(tree, '刷新'))
  h.close()
  h.reopen()
  await tick()
  tree = h.render()
  assert.ok(button(tree, '刷新'))
  h.dispose()
  assert.equal(h.doc.listenerCount('keydown'), 0)
})

for (const code of ['storage_reload_required', 'runtime_reload_required', 'unauthorized', 'forbidden']) {
  test(`dynamic: ${code} retains last good statistics and removes futile Retry`, async () => {
    let attempt = 0
    const h = fixture(async () => ++attempt === 1 ? { ...stats(5), storageSafety: { mode: 'host-json', state: 'open' } }
      : { ready: false, code, error: 'synthetic terminal error', ...(code === 'storage_reload_required' ? { storageSafety: { mode: 'guarded-native', state: 'poisoned' } } : {}) }, true)
    h.render()
    await tick()
    assert.match(text(h.render()), /no cross-process writer lock/)
    const oldRefresh = button(h.render(), 'Refresh').props.onClick
    oldRefresh()
    await tick()
    assert.match(text(h.render()), /5 entries/)
    assert.equal(walk(h.render(), node => node.type === 'button').length, 0)
    assert.match(text(h.render()), code === 'unauthorized' ? /Sign in again/ : code === 'forbidden' ? /does not have permission/ : /reload the plugin/)
    oldRefresh()
    await tick()
    assert.equal(h.calls.length, 2)
    h.dispose()
  })
}

test('dynamic: structured temporary unavailable remains read-retryable and preserves statistics', async () => {
  let attempt = 0
  const h = fixture(async () => ++attempt === 1 ? stats(6) : attempt === 2
    ? { ready: false, code: 'storage_unavailable', retryable: true, error: 'synthetic retryable failure', storageSafety: { mode: 'host-json', state: 'unavailable' } }
    : stats(7), true)
  h.render()
  await tick()
  button(h.render(), 'Refresh').props.onClick()
  await tick()
  assert.match(text(h.render()), /6 entries.*Retry|Retry.*6 entries/)
  button(h.render(), 'Retry').props.onClick()
  await tick()
  assert.match(text(h.render()), /7 entries/)
  h.dispose()
})

test('static: follows the DSH locale, localizes every panel state, and keeps drafts across a switch', async () => {
  const locale = localeService('en')
  const payload = { ...list(['first synthetic entry', 'second synthetic entry']), user: ['user synthetic entry'],
    storageSafety: { mode: 'host-json', state: 'open' }, backgroundReview: { enabled: true, interval: 10, status: 'completed' },
    pending: [{ id: 'synthetic-pending', target: 'memory', operations: [{ action: 'patch', oldText: 'old synthetic', content: 'new synthetic' }] }] }
  const h = fixture(async () => response(payload), false, { locale })
  h.show()
  await tick()
  const untranslated = () => {
    const tree = h.render()
    return [tree, sectionView(tree), sectionView(tree, 'user')].flatMap(visibleStrings).filter(value => HAN.test(value))
  }
  let tree = h.render()
  assert.match(text(tree), /Storage protection · host JSON mode/)
  assert.match(text(tree), /Background review · every 10 user turns · last review completed/)
  assert.match(text(tree), /Pending changes · 1/)
  assert.match(text(tree), /Original: old synthetic/)
  for (const label of ['Approve', 'Discard', 'Export backup', 'Refresh']) assert.ok(walk(tree, node => text(node).includes(label)).length > 0, label)
  const view = sectionView(tree), actions = walk(view, node => node.props.className === 'hm-action')
  assert.equal(actions[0].props['aria-label'], 'Edit MEMORY entry 1: first synthetic entry')
  assert.equal(actions[1].props['aria-label'], 'Delete MEMORY entry 1: first synthetic entry')
  assert.equal(walk(view, node => node.type === 'input')[0].props['aria-label'], 'Add a MEMORY memory entry')
  assert.match(text(view), /2 entries/)
  assert.match(text(sectionView(tree, 'user')), /1 entry(?!\w)/)
  assert.deepEqual(untranslated(), [])
  button(tree, 'Compact history details').props.onClick()
  assert.match(text(h.render()), /Export a backup first/)
  assert.deepEqual(untranslated(), [])
  section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'first synthetic entry', text: 'edited synthetic draft' })
  assert.ok(button(sectionView(h.render()), 'Save'))
  assert.deepEqual(untranslated(), [])
  section(h.render()).onCancel()
  section(h.render()).onRemove('memory', 'first synthetic entry', 0)
  assert.match(text(sectionView(h.render())), /Delete this memory entry\?/)
  assert.ok(button(sectionView(h.render()), 'Confirm delete'))
  assert.deepEqual(untranslated(), [])
  section(h.render()).onCancelRemove()
  section(h.render()).onDraft('kept synthetic draft')
  locale.switchTo('zh-CN')
  tree = h.render()
  assert.ok(button(tree, '刷新'))
  assert.match(text(tree), /后台复盘 · 每 10 轮用户对话 · 最近复盘已完成/)
  assert.equal(section(tree).draft, 'kept synthetic draft')
  locale.switchTo('fr')
  assert.ok(button(h.render(), 'Refresh'), 'languages without a panel dictionary use English, like DSH')
  assert.equal(locale.listeners.size, 1)
  h.dispose()
  assert.equal(locale.listeners.size, 0)
})

test('static: English recovery text names the action for expired logins and stale drafts', async () => {
  const expired = fixture(async () => response({ error: 'synthetic expired session' }, 401), false, { locale: localeService('en') })
  expired.show()
  await tick()
  let tree = expired.render()
  assert.match(text(tree), /Your login has expired\. Sign in again, then reload this page \(synthetic expired session\)/)
  assert.match(text(tree), /Memory is not loaded\. Follow the message above to restore access/)
  assert.equal(walk(tree, node => node.type === 'button' && /Refresh|Retry/.test(text(node))).length, 0)
  assert.deepEqual(visibleStrings(tree).filter(value => HAN.test(value)), [])
  expired.dispose()

  let writes = 0
  const h = fixture(async (_path, init) => JSON.parse(init.body).action === 'list'
    ? response({ ...list(), entryVersions: { memory: ['v:old'], user: [] } })
    : (++writes, response({ success: false, code: 'row_conflict', conflict: true, error: 'synthetic row conflict' }, 409)),
  false, { locale: localeService('en-GB') })
  h.show()
  await tick()
  section(h.render()).onEdit({ bank: 'memory', index: 0, original: 'synthetic entry', text: 'conflicting draft' })
  section(h.render()).onSave()
  await tick()
  const view = sectionView(h.render())
  assert.match(text(view), /Save failed: The entry changed, was recreated, or its version is out of date\. Check the latest list, then start editing again \(synthetic row conflict\)\. Your draft is kept\./)
  assert.match(text(view), /out of date, so Save is disabled/)
  assert.equal(button(view, 'Save').props.disabled, true)
  await section(h.render()).onCopy()
  assert.equal(h.copied[0], 'conflicting draft')
  assert.match(text(sectionView(h.render())), /Draft copied\. Click Cancel, refresh the list/)
  assert.equal(writes, 1)
  h.dispose()
})

test('dynamic: follows the DSH locale for statistics and recovery labels; English without a locale service', async () => {
  const locale = localeService('zh')
  let attempt = 0
  const h = fixture(async () => ++attempt === 1 ? stats(1) : { ready: false, code: 'unauthorized', error: 'synthetic expired session' }, true, { locale })
  h.render()
  await tick()
  assert.match(text(h.render()), /🧠 Hermes 记忆/)
  assert.match(text(h.render()), /MEMORY\.md 1 条/)
  button(h.render(), '刷新').props.onClick()
  await tick()
  assert.match(text(h.render()), /登录已过期/)
  assert.equal(walk(h.render(), node => node.type === 'button').length, 0)
  locale.switchTo('en')
  assert.match(text(h.render()), /Your login has expired/)
  assert.match(text(h.render()), /MEMORY\.md 1 entry ·/)
  h.dispose()
  assert.equal(locale.listeners.size, 0)
  const fallback = fixture(async () => stats(2), true)
  fallback.render()
  await tick()
  assert.match(text(fallback.render()), /🧠 Hermes Memory.*MEMORY\.md 2 entries/)
  fallback.dispose()
})

test('real Cordis: the locale service is optional, may arrive after the panel, and is released on unload', async () => {
  const require = createRequire(import.meta.url)
  const { Context } = require('@deepseek-ai/cordis')
  const runner = hooks(), doc = documentStub(), entries = new Map()
  const keyOf = (options) => options.name === 'main' ? `main:${options.key}`
    : options.name === 'sidebar.panellist' ? `panellist:${options.id}`
      : options.id || options.key
  const slots = {
    register(options, component) { const key = keyOf(options); entries.set(key, component); return () => entries.delete(key) },
    inject(_slot, effect) { return effect() },
  }
  let plugin
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => runner.React) } } },
    document: doc, fetch: async () => response(list()),
  })
  const ctx = new Context()
  const slotsFiber = ctx.plugin({ apply(c) { c.provide('slots', slots) } })
  await slotsFiber
  const panelFiber = ctx.plugin(plugin)
  await panelFiber
  const render = () => runner.render('view', entries.get('main:hermes-memory'), tree => doc.commit('view', tree))
  render()
  await tick()
  assert.ok(button(render(), '刷新'), 'no locale service keeps the original Chinese panel')
  const locale = localeService('en')
  const localeFiber = ctx.plugin({ apply(c) { c.provide('locale', locale) } })
  await localeFiber
  await tick()
  assert.ok(button(render(), 'Refresh'), 'a locale service provided later is still followed')
  locale.switchTo('zh-TW')
  assert.ok(button(render(), '刷新'))
  assert.equal(locale.listeners.size, 1)
  await localeFiber.dispose()
  assert.equal(locale.listeners.size, 0, 'unloading the locale service releases the subscription')
  assert.ok(button(render(), '刷新'), 'the last language stays in place without the service')
  await panelFiber.dispose()
  await slotsFiber.dispose()
})

test('static: sidebar.panellist registers an icon and a locale-aware panel label', async () => {
  const runner = hooks(), doc = documentStub(), entries = new Map(), descriptors = new Map()
  const slots = {
    register(options, component) {
      const key = options.name === 'main' ? `main:${options.key}` : options.id || options.key
      entries.set(key, component)
      descriptors.set(options.id || options.key, options)
      return () => { entries.delete(key); descriptors.delete(options.id || options.key) }
    },
    inject(_slot, fn) { return fn() },
  }
  const locale = localeService('en')
  let plugin
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(registration) { plugin = registration.factory(() => runner.React) } } },
    document: doc, fetch: async () => response(list()), navigator: { clipboard: { async writeText() {} } },
  })
  plugin.apply({
    get: name => name === 'slots' ? slots : name === 'locale' ? locale : undefined,
    effect: fn => fn(),
    inject: (_deps, fn) => fn({ get: name => name === 'locale' ? locale : undefined, effect: fn2 => fn2() }),
  })
  const descriptor = descriptors.get('hermes-memory')
  assert.equal(descriptor.name, 'sidebar.panellist')
  assert.equal(descriptor.id, 'hermes-memory')
  assert.equal(typeof descriptor.label, 'function')
  assert.equal(descriptor.label(), 'Memory')
  const icon = runner.render('icon', () => entries.get('hermes-memory')({ size: 18, active: true }), tree => doc.commit('icon', tree))
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.props.height, 18)
  assert.equal(icon.props['aria-hidden'], true)
  assert.equal(icon.children.length, 2)
  locale.switchTo('zh-CN')
  assert.equal(descriptor.label(), '记忆')
})

test('real Cordis: the dynamic card follows a locale service provided after the plugin and releases it', async () => {
  const require = createRequire(import.meta.url)
  const { Context } = require('@deepseek-ai/cordis')
  const runner = hooks(), entries = new Map()
  const slots = {
    register(options, component) { const key = options.id || options.key; entries.set(key, component); return () => entries.delete(key) },
    inject(_slot, fn) { return fn() },
  }
  const plugin = vm.runInNewContext(`(function () { ${dynamicSource}\n})()`, {
    React: runner.React, host: { call: async () => stats(2) },
  })
  const ctx = new Context()
  const slotsFiber = ctx.plugin({ apply(c) { c.provide('slots', slots) } })
  await slotsFiber
  const cardFiber = ctx.plugin(plugin)
  await cardFiber
  const render = () => runner.render('card', entries.get('self'))
  render()
  await tick()
  assert.match(text(render()), /Hermes Memory/, 'no locale service keeps the card in English')
  assert.match(text(render()), /MEMORY\.md 2 entries/)
  const locale = localeService('zh')
  const localeFiber = ctx.plugin({ apply(c) { c.provide('locale', locale) } })
  await localeFiber
  await tick()
  assert.match(text(render()), /Hermes 记忆/, 'a locale service provided after the plugin is still followed')
  assert.match(text(render()), /2 条/)
  locale.switchTo('en')
  assert.match(text(render()), /Hermes Memory/)
  assert.equal(locale.listeners.size, 1)
  await localeFiber.dispose()
  assert.equal(locale.listeners.size, 0, 'unloading the locale service releases the card subscription')
  assert.match(text(render()), /Hermes Memory/, 'the last language stays in place without the service')
  await cardFiber.dispose()
  await slotsFiber.dispose()
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
  assert.throws(() => slots.register({ name: 'main', key: 'ungated' }, () => null), /not declared/)
  const counts = () => ['main', 'sidebar.panellist'].map((name) => slots.entriesOfSlot(name).length)
  const declare = () => slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
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
