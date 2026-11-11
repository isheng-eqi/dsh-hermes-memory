import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { apply, inject } from '../lib/index.js'

export const timers = {
  timeout(callback, delay) { const id = setTimeout(callback, delay); id.unref?.(); return () => clearTimeout(id) },
  interval(callback, delay) { const id = setInterval(callback, delay); id.unref?.(); return () => clearInterval(id) },
}
export function canonicalMemory(args) {
  if (args.target !== undefined && args.operations !== undefined) return args
  const source = args.action === 'batch' ? args.operations : [args]
  const operations = source?.map(op => {
    if (!op || Array.isArray(op) || typeof op !== 'object') return op
    const { oldText, target, ...rest } = op
    return { ...rest, action: rest.action === 'replace' ? 'patch' : rest.action, ...(oldText === undefined ? {} : { old_text: oldText }) }
  })
  return { target: args.target || 'memory', operations }
}

/** Opaque Session double: only the projection fixture can see its log. */
export function projectionFixture() {
  const logs = new WeakMap()
  let definition, cells = new WeakMap(), releases = 0
  return {
    service: {
      async register(unit) {
        assert.equal(typeof unit.stateSchema.parse, 'function')
        assert.equal(typeof unit.stateVersion, 'number')
        definition = unit
        await Promise.resolve()
        return {
          stateOf(session) {
            let cell = cells.get(session)
            if (!cell) cells.set(session, cell = { state: unit.init(session.header, session.inheritedEventCount), cursor: 0 })
            const log = logs.get(session)
            assert.ok(log, 'session must belong to the projection fixture')
            while (cell.cursor < log.length) cell.state = unit.apply(cell.state, log[cell.cursor++])
            return cell.state
          },
          async dispose() { releases++ },
        }
      },
    },
    session(id = 'session-test', seed = [], inheritedEventCount = 0) {
      const log = structuredClone(seed)
      const session = {
        id, header: { id, isSeeded: inheritedEventCount > 0 }, inheritedEventCount,
        get seq() { return log.length },
        requestHeader: () => ({ config: { provider: 'synthetic', model: 'synthetic' } }),
        deriveMessages: () => log.flatMap(event => event.type === 'user/message' ? [event.data] : event.type === 'assistant/message' ? [event.data.message] : []),
        append(type, data) {
          const event = { type, data, seq: log.length, time: Date.now() }
          log.push(event)
          return event
        },
      }
      logs.set(session, log)
      return session
    },
    seed(session) { return structuredClone(logs.get(session)) },
    get definition() { return definition },
    get releases() { return releases },
  }
}

export async function activateHost(mode, ctx, config = {}, options = {}) {
  if (mode === 'static') {
    assert.ok(inject.includes('sessionProjections'))
    return await apply(ctx, { memoryCharLimit: 2200, userCharLimit: 1375, nudgeInterval: 10, ...config })
  }
  const source = await readFile(new URL('../host.js', import.meta.url), 'utf8')
  const plugin = runInNewContext('(function () {\n' + source + '\n})()', {
    harness: options.harness || {
      defineTool: value => value,
      registerTool: (owner, tool) => owner.tools.register(tool),
      handle: () => () => {},
    },
    console, TextEncoder, TextDecoder,
  })
  assert.ok(plugin.inject.includes('sessionProjections'))
  return await plugin.apply(ctx)
}
