import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const NAMES = new Set(['hermes_memory', 'hermes_memory_runtime'])
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)
const clone = value => JSON.parse(JSON.stringify(value))
const failure = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const same = (a, b) => a === null ? b === null : b !== null && a.stamp === b.stamp && a.hash === b.hash

async function observe(path) {
  let before
  try { before = await fs.lstat(path, { bigint: true }) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink()) throw failure('external-change', 'Guarded storage requires a regular, non-symlink file: ' + path)
  const bytes = await fs.readFile(path)
  const after = await fs.lstat(path, { bigint: true })
  if (stamp(before) !== stamp(after)) throw failure('external-change', 'Storage changed while being inspected: ' + path)
  return { stamp: stamp(after), hash: digest(bytes), text: bytes.toString('utf8') }
}

function parse(descriptor, snapshot) {
  if (snapshot === null) return { version: descriptor.version, global: null, tables: Object.fromEntries(descriptor.tables.map(name => [name, {}])) }
  let value
  try { value = JSON.parse(snapshot.text) } catch (cause) { throw failure('malformed-medium', 'Storage is not valid JSON: ' + descriptor.name, cause) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.unit || value.unit.name !== descriptor.name || !Number.isSafeInteger(value.unit.version)) {
    throw failure('malformed-medium', 'Invalid storage unit header: ' + descriptor.name)
  }
  if (value.unit.version !== descriptor.version && !descriptor.compatibleVersions?.includes(value.unit.version)) {
    throw failure('version-mismatch', 'Unsupported storage version for ' + descriptor.name)
  }
  if (!value.tables || typeof value.tables !== 'object' || Array.isArray(value.tables)) throw failure('malformed-medium', 'Invalid storage tables: ' + descriptor.name)
  const tables = {}
  for (const name of descriptor.tables) {
    const rows = value.tables[name] === undefined ? {} : value.tables[name]
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw failure('malformed-medium', 'Invalid table: ' + name)
    Object.defineProperty(tables, name, { value: clone(rows), enumerable: true, configurable: true, writable: true })
  }
  return { version: descriptor.version, global: clone(value.global ?? null), tables }
}

/**
 * Opt-in native owner for the two existing DSH single-document memory units.
 * The lease coordinates participating writers only. It never steals an old lock.
 * Uncoordinated editors can still race the final comparison and rename.
 * Test options replace only nondeterministic publication and timing operations.
 */
export async function createGuardedStorage(root, testOptions = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw failure('invalid-root', 'Guarded storage root must be an absolute path')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  root = await fs.realpath(root)
  const lockPath = join(root, '.hermes-memory.lock')
  const token = randomUUID()
  const lease = { token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }
  const leaseText = JSON.stringify(lease) + '\n'
  let handle
  try { handle = await fs.open(lockPath, 'wx', 0o600) } catch (cause) {
    if (cause.code === 'EEXIST') throw failure('writer-active', 'Guarded memory writer lease already exists: ' + lockPath, cause)
    if (cause.code === 'EPERM') {
      try { await fs.lstat(lockPath); throw failure('writer-active', 'Guarded memory writer lease already exists: ' + lockPath, cause) } catch (error) {
        if (error.code === 'writer-active') throw error
      }
    }
    throw cause
  }
  const identity = await handle.stat({ bigint: true })
  let error = null, closing = false, closed = false, closePromise
  let chain = Promise.resolve(), heartbeat
  const expected = new Map(), units = new Map(), opening = new Set()
  const poison = cause => { error ||= cause; return error }
  const healthy = () => { if (error) throw error; if (closed) throw failure('closed', 'Guarded storage is closed') }
  const accepting = () => { healthy(); if (closing) throw failure('closed', 'Guarded storage is closing') }
  const enqueue = operation => {
    const result = chain.then(operation)
    chain = result.catch(() => {})
    return result
  }
  async function ownsLease() {
    const stat = await fs.lstat(lockPath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false
    return await fs.readFile(lockPath, 'utf8') === leaseText
  }
  async function checkLease() {
    try { if (!await ownsLease()) throw failure('lease-lost', 'Guarded memory writer lease was replaced') } catch (cause) {
      throw poison(cause.code === 'lease-lost' ? cause : failure('lease-lost', 'Guarded memory writer lease cannot be verified', cause))
    }
  }
  async function checkFiles() {
    healthy()
    await checkLease()
    for (const name of NAMES) {
      try {
        if (!same(expected.get(name), await observe(join(root, name + '.json')))) throw failure('external-change', 'Storage changed outside this writer: ' + name)
      } catch (cause) {
        throw poison(cause.code === 'external-change' ? cause : failure('external-change', 'Cannot verify storage before publication: ' + name, cause))
      }
    }
  }
  async function release() {
    let own = false
    try { own = await ownsLease() } catch { /* A changed or malformed lease belongs to an operator, not this cleanup. */ }
    await handle.close()
    if (own) {
      // Token and inode must still agree after closing the held handle on Windows.
      try { if (await ownsLease()) await fs.unlink(lockPath) } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
      }
    }
  }
  try {
    await handle.writeFile(leaseText, 'utf8')
    await handle.sync()
    for (const name of NAMES) expected.set(name, await observe(join(root, name + '.json')))
    await checkLease()
  } catch (cause) {
    await release().catch(() => {})
    throw cause
  }
  const rename = testOptions.rename || fs.rename
  const sleep = testOptions.sleep || wait
  const platform = testOptions.platform || process.platform
  async function publish(name, state) {
    const path = join(root, name + '.json')
    const data = JSON.stringify({ unit: { name, version: state.version }, global: state.global, tables: state.tables }, null, 2) + '\n'
    await checkFiles()
    const temporary = join(root, '.' + randomUUID() + '.tmp')
    let published = false, temporaryCreated = false
    try {
      const tempHandle = await fs.open(temporary, 'wx', 0o600)
      temporaryCreated = true
      try { await tempHandle.writeFile(data, 'utf8'); await tempHandle.sync() } finally { await tempHandle.close() }
      for (let attempt = 0;; attempt++) {
        await checkFiles()
        try { await rename(temporary, path); published = true; break } catch (cause) {
          if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(cause.code) || attempt >= 5) throw cause
        }
        await sleep(10 * 2 ** attempt)
      }
      const saved = await observe(path)
      if (!saved || saved.hash !== digest(Buffer.from(data))) throw failure('external-change', 'Published storage changed before verification: ' + name)
      expected.set(name, saved)
      if (platform !== 'win32') {
        const directory = await fs.open(root, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (cause) {
      throw poison(['external-change', 'lease-lost'].includes(cause.code) ? cause : failure('unknown-state', 'Guarded memory publication failed; stop and inspect both files before reopening' + (published ? ' (replacement completed)' : ''), cause))
    } finally { if (temporaryCreated) await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  let heartbeatPending = false
  heartbeat = setInterval(() => {
    if (closing || closed || error || heartbeatPending) return
    heartbeatPending = true
    enqueue(async () => {
      try {
        if (error || closed) return
        await checkLease()
        const now = new Date()
        await handle.utimes(now, now)
      } catch (cause) { poison(failure('lease-lost', 'Guarded memory heartbeat failed', cause)) }
      finally { heartbeatPending = false }
    })
  }, testOptions.heartbeatMs || 15000)
  heartbeat.unref?.()

  function descriptorOf(value) {
    if (!value || !NAMES.has(value.name) || !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.tables)
      || value.tables.some(name => !validName(name)) || new Set(value.tables).size !== value.tables.length || typeof value.hasGlobal !== 'boolean'
      || value.layout !== undefined && value.layout !== 'single'
      || value.compatibleVersions !== undefined && (!Array.isArray(value.compatibleVersions) || value.compatibleVersions.some(version => !Number.isSafeInteger(version) || version < 0))) {
      throw failure('invalid-descriptor', 'Guarded storage accepts only the two memory units in single layout')
    }
    return clone(value)
  }
  const backend = {
    kv: { async open(input) {
      accepting()
      const descriptor = descriptorOf(input), name = descriptor.name
      if (units.has(name) || opening.has(name)) throw failure('already-open', 'Storage unit is already open: ' + name)
      opening.add(name)
      try { return await enqueue(async () => {
        await checkFiles()
        let state = parse(descriptor, expected.get(name)), unitClosed = false
        const submit = operation => {
          try { accepting() } catch (cause) { return Promise.reject(cause) }
          if (unitClosed) return Promise.reject(failure('closed', 'Storage unit is closed: ' + name))
          return enqueue(operation)
        }
        const mutate = change => submit(async () => {
          await checkFiles()
          const next = clone(state)
          if (change(next) === false) return
          await publish(name, next)
          state = next
        })
        const table = (state, name) => {
          if (!Object.hasOwn(state.tables, name)) throw failure('invalid-table', 'Undeclared table: ' + name)
          return state.tables[name]
        }
        const unit = {
          get closed() { return unitClosed || closed },
          loadAll: () => submit(async () => { await checkFiles(); return clone({ global: state.global, tables: state.tables }) }),
          setGlobal(value) {
            if (!descriptor.hasGlobal) return Promise.reject(failure('invalid-global', 'Unit has no global slot'))
            return mutate(next => { next.global = clone(value) })
          },
          putRecord: (name, key, value) => mutate(next => { Object.defineProperty(table(next, name), key, { value: clone(value), enumerable: true, configurable: true, writable: true }) }),
          deleteRecord(name, key) { return this.deleteRecords(name, [key]) },
          deleteRecords: (name, keys) => mutate(next => {
            const rows = table(next, name)
            let changed = false
            for (const key of keys) if (Object.hasOwn(rows, key)) { delete rows[key]; changed = true }
            return changed
          }),
          async close() {
            if (unitClosed) { await chain; return }
            unitClosed = true
            await enqueue(async () => { if (units.get(name) === unit) units.delete(name) })
          },
        }
        units.set(name, unit)
        return unit
      }) } finally { opening.delete(name) }
    } },
    status() { return { mode: 'guarded-native', root, state: closed ? 'closed' : closing ? 'closing' : error ? 'poisoned' : 'open', error: error ? { code: error.code, message: error.message } : null, lease: { pid: lease.pid, hostname: lease.hostname, createdAt: lease.createdAt } } },
    close() {
      if (closePromise) return closePromise
      closing = true
      clearInterval(heartbeat)
      closePromise = (async () => {
        await chain
        try { await release() } finally { closed = true; units.clear() }
      })()
      return closePromise
    },
  }
  return backend
}
