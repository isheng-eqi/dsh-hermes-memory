/**
 * dsh-hermes-memory — Hermes-style persistent memory for DeepSeek Harness.
 *
 * A DSH adaptation of the hermes-agent `MemoryStore` mechanism
 * (NousResearch/hermes-agent, `tools/memory_tool.py`): two stores —
 * MEMORY.md (the agent's personal notes) and USER.md (what the agent knows
 * about the user) — persisted as §-delimited entries under character limits,
 * injected into each session as a frozen snapshot, and maintained by the
 * model through one `memory` tool.
 *
 * Storage uses the DSH storage hub's json backend (KvUnit `hermes_memory`
 * at ~/.dsh/storages/hermes_memory.json): atomic, versioned, human-readable,
 * cross-session and cross-restart durable. No external dependencies beyond
 * the DSH packages; no LLM calls (agent-curated writes).
 *
 * ⚠️ 同步声明：本文件是静态 bundle 形态的权威实现；`host.js` 是动态插件
 * 形态的镜像（运行在 node:vm sandbox 中无法 import 本文件，只能复制）。
 * 改本文件的合并协议/注入逻辑时，务必同步修改 host.js 中对应代码。
 * 纯逻辑（合并协议、渲染、转义）的权威版本在 `lib/core.js`。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import {
  ENTRY_DELIMITER,
  MAX_CONSOLIDATION_FAILURES,
  consolidationFailure,
  countChars,
  scanMemoryContent,
  escapeFrame,
  renderBankList,
  renderEntries,
  slugKey,
  stepOperation,
  str,
  validateOperation,
} from './core.js'

export const name = 'dsh-hermes-memory'

/** Deployment configuration; every tunable is validated at load. */
export const Config = Schema.object({
  /** Character budget for MEMORY.md entries. Defaults to 2200 (hermes-agent default). */
  memoryCharLimit: Schema.natural().default(2200),
  /** Character budget for USER.md entries. Defaults to 1375 (hermes-agent default). */
  userCharLimit: Schema.natural().default(1375),
  /** Turns without a memory write before the persistence nudge; 0 disables it. Defaults to 10. */
  nudgeInterval: Schema.natural().default(10),
  /** Apply bounded Hermes threat-pattern checks to writes and prompt snapshots. */
  contentGuard: Schema.boolean().default(true),
})

export const inject = ['tools']

export function apply(ctx, config) {
  // ---------------- 常量与状态 ----------------
  const BANKS = ['memory', 'user']
  const LIMITS = { memory: config.memoryCharLimit ?? 2200, user: config.userCharLimit ?? 1375 }
  const NUDGE_INTERVAL = config.nudgeInterval ?? 10
  const CONTENT_GUARD = config.contentGuard ?? true
  const MARKER_SNAPSHOT = '<hermes-memory-snapshot>'
  const MARKER_NUDGE = '<hermes-memory-nudge>'
  const RULER = '═'.repeat(46)
  const SYSTEM_REMINDER_OPEN = '<system-reminder>'
  const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
  const HEADERS = { memory: 'MEMORY (your personal notes)', user: 'USER PROFILE (who the user is)' }
  /** 兼容动态形态（host.js）历史消息的 source.plugin 值。 */
  const PLUGIN_IDS = ['hermes-memory', 'dsh-hermes-memory']

  const store = {
    unit: null,
    tables: { memory: new Map(), user: new Map() },
    seq: { memory: 0, user: 0 },
    chain: Promise.resolve(),
    ready: false,
    disposed: false,
    error: null,
    openAttempts: 0,
  }
  const failures = new Map() // sessionId -> consolidation failure count this turn
  const lastNudgeTurn = new Map()
  const lastWriteEventCount = new Map()
  const activeSessionEventCount = new Map() // sessionId -> event count at the latest pre-step
  let lastOpenAttemptAt = 0 // 节流：存储重试间隔（ms）

  // ---------------- 工具函数 ----------------
  const enqueue = (task) => {
    const p = store.chain.then(task)
    store.chain = p.catch(() => {})
    return p
  }
  const entriesOf = (bank) => [...store.tables[bank].values()].sort((a, b) => a.seq - b.seq).map((r) => r.text)
  const charCount = (bank) => countChars(renderEntries(entriesOf(bank)))
  const usageLine = (bank) => {
    const current = charCount(bank)
    const limit = LIMITS[bank]
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0
    return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`
  }
  const storageBackend = () => {
    const storage = ctx.get('storage')
    if (storage === undefined) return undefined
    return storage.backend.get('json')
  }

  // ---------------- 存储（单一持有者，失败不覆盖） ----------------
  async function openStore() {
    const backend = storageBackend()
    if (backend === undefined || backend.kv === undefined) throw new Error('json 存储后端不可用')
    // Version 2 commits both banks as one singleton, so a batch is one durable write.
    // Version 1 table records remain available as an upgrade recovery copy.
    const unit = await backend.kv.open({
      name: 'hermes_memory', version: 2, compatibleVersions: [1], tables: BANKS, hasGlobal: true,
    })
    try {
      const snap = await unit.loadAll()
      if (store.disposed) throw new Error('memory plugin is disposed')
      const tables = snap.global === null ? snap.tables : snap.global.tables
      if (snap.global !== null && snap.global.format !== 2) throw new Error('Unsupported memory snapshot format')
      const loaded = { memory: new Map(), user: new Map() }
      const seq = { memory: 0, user: 0 }
      for (const bank of BANKS) {
        const records = tables && tables[bank]
        if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Malformed memory bank: ' + bank)
        const sequences = new Set()
        for (const [key, record] of Object.entries(records)) {
          if (!record || typeof record.text !== 'string' || !Number.isSafeInteger(record.seq) || record.seq < 1) {
            throw new Error('Malformed memory record in ' + bank + '; saved data was left unchanged')
          }
          if (sequences.has(record.seq)) throw new Error('Duplicate memory sequence in ' + bank + '; saved data was left unchanged')
          sequences.add(record.seq)
          loaded[bank].set(key, record)
          seq[bank] = Math.max(seq[bank], record.seq)
        }
      }
      store.tables = loaded
      store.seq = seq
      store.unit = unit
      store.ready = true
      store.error = null
      store.openAttempts += 1
    } catch (error) {
      await unit.close()
      throw error
    }
  }

  let initPromise = null
  function ensureReady() {
    if (store.disposed) return Promise.reject(new Error('memory plugin is disposed'))
    if (store.ready) return Promise.resolve()
    if (initPromise === null) {
      initPromise = openStore().catch((e) => {
        store.error = String((e && e.message) || e)
        initPromise = null
        throw e
      })
    }
    return initPromise
  }
  ctx.effect(() => {
    ensureReady().catch(() => {})
    // 无 storage 的 profile（headless/TUI/自定义 base-only）上，store 打不开且
    // 会静默半工作：延迟 3s 后仍不可用才打一次性警告（web 上 storage 行随
    // bundle 立即激活，正常启动不会触发；30s 节流重试与工具调用照常进行）。
    const warnTimer = setTimeout(() => {
      if (!store.ready && store.error !== null) {
        console.warn(
          `[dsh-hermes-memory] memory store not ready: ${store.error} — the storage hub rows `
          + '(storage / storage-json / storage-domain) ship with the web bundle only; on '
          + "headless/TUI/custom profiles add them to that profile's cordis.patch.yml (see README)",
        )
      }
    }, 3000)
    // disposer 返回 Promise：纤维销毁时等待 close 完成，避免关闭竞态
    return async () => {
      clearTimeout(warnTimer)
      store.disposed = true
      await initPromise?.catch(() => {})
      await store.chain
      store.ready = false
      const unit = store.unit
      store.unit = null
      if (unit) await unit.close()
    }
  })

  // ---------------- 合并协议（核心逻辑在 core.js，此处只做编排） ----------------
  function applyBatch(bank, operations, sessionId) {
    // Serialize the complete read/validate/commit, not just individual record writes.
    return enqueue(() => commitBatch(bank, operations, sessionId))
  }
  async function commitBatch(bank, operations, sessionId) {
    await ensureReady()
    if (operations.length === 0) {
      return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, { success: false, target: bank, error: 'operations list is empty.' }, sessionId)
    }
    for (let i = 0; i < operations.length; i++) {
      const problem = validateOperation(operations[i])
      if (problem !== null) {
        return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, {
          success: false,
          target: bank,
          error: `Operation ${i + 1}: ${problem} No operations were applied (batch is all-or-nothing).`,
          currentEntries: entriesOf(bank),
          usage: usageLine(bank),
        }, sessionId)
      }
    }
    const limit = LIMITS[bank]
    const recs = [...store.tables[bank].values()].sort((a, b) => a.seq - b.seq)
    const working = recs.map((r) => ({ text: r.text, seq: r.seq, createdAt: r.createdAt, updatedAt: r.updatedAt }))
    working.bank = bank
    // 局部序号计数器：失败回滚时不污染全局 seq（#7）
    const seqCounter = { next: store.seq[bank] + 1 }
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]
      const failure = stepOperation(working, op, `Operation ${i + 1} (${op.action})`, seqCounter)
      if (failure !== null) {
        return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, {
          success: false,
          target: bank,
          error: `${failure} No operations were applied (batch is all-or-nothing).`,
          currentEntries: entriesOf(bank),
          usage: usageLine(bank),
        }, sessionId)
      }
    }
    if (countChars(renderEntries(working.map((w) => w.text))) > limit) {
      return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, {
        success: false,
        target: bank,
        error: [
          `After applying all ${operations.length} operations, memory would be at`,
          `${countChars(renderEntries(working.map((w) => w.text))).toLocaleString()}/${limit.toLocaleString()} chars — over the limit.`,
          'Remove or shorten more entries in the same batch (see current_entries below), then retry.',
        ].join(' '),
        currentEntries: entriesOf(bank),
        usage: usageLine(bank),
      }, sessionId)
    }
    if (CONTENT_GUARD) {
      const unchanged = new Set(recs.map(record => record.text))
      for (const record of working) {
        if (unchanged.has(record.text)) continue
        const threat = scanMemoryContent(record.text)
        if (threat) return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, {
          success: false, target: bank, error: 'Blocked memory content: ' + threat + '. No operations were applied.',
          currentEntries: entriesOf(bank), usage: usageLine(bank),
        }, sessionId)
      }
    }
    const before = new Map(store.tables[bank])
    const tasks = []
    for (const [key, rec] of before) {
      const match = working.find((w) => w.seq === rec.seq)
      if (!match) tasks.push({ kind: 'del', bank, key })
      else if (match.text !== rec.text) tasks.push({ kind: 'put', bank, key, record: { ...rec, text: match.text, updatedAt: match.updatedAt } })
    }
    for (const w of working) {
      const existing = [...before.values()].find((r) => r.seq === w.seq)
      if (!existing) tasks.push({ kind: 'put', bank, key: `${w.seq}-${slugKey(w.text)}`, record: w })
    }
    const updated = new Map(before)
    for (const task of tasks) {
      if (task.kind === 'del') updated.delete(task.key)
      else updated.set(task.key, task.record)
    }
    if (tasks.length > 0) {
      const tables = Object.fromEntries(BANKS.map(name => [name, Object.fromEntries(name === bank ? updated : store.tables[name])]))
      try {
        await store.unit.setGlobal({ format: 2, tables })
      } catch (error) {
        if (error && error.code === 'unknown-state') {
          store.ready = false
          store.error = 'Memory storage outcome is unknown; reload the plugin before retrying'
          // Keep the rejected initialization promise: no further read or write may claim success.
          initPromise = Promise.reject(new Error(store.error))
          initPromise.catch(() => {})
        }
        throw error
      }
      store.tables[bank] = updated
    }
    store.seq[bank] = seqCounter.next - 1

    failures.delete(sessionId)
    if (sessionId !== 'ui') lastWriteEventCount.set(sessionId, activeSessionEventCount.get(sessionId) ?? 0)
    return {
      success: true,
      done: true,
      target: bank,
      message: operations.length === 1 ? 'Entry updated.' : `Applied ${operations.length} operation(s).`,
      usage: usageLine(bank),
      entryCount: entriesOf(bank).length,
      note: 'Write saved. This update is complete — do not repeat it.',
    }
  }

  // ---------------- 工具 ----------------
  function registerTool(name, description, parameters, renderText, execute) {
    return ctx.tools.register(defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      async execute(args, exec) {
        if (exec.signal.aborted) throw new Error(`${name}: cancelled`)
        try {
          return await execute(args, exec)
        } catch (e) {
          throw new Error(`${name}: ${(e && e.message) || e}`)
        }
      },
    }))
  }
  const sessionIdOf = (exec) => {
    try {
      const agents = ctx.get('agents')
      const agent = (exec && exec.agent) || (agents ? agents.currentInitiator() : undefined)
      return agent && agent.session ? String(agent.session.id) : 'anon'
    } catch { return 'anon' }
  }
  const renderWriteResult = (v) => {
    const lines = []
    if (v.error !== undefined) {
      lines.push(`memory error: ${v.error}`)
      if (v.usage !== undefined) lines.push(`usage: ${v.usage}`)
      if (v.currentEntries !== undefined && v.currentEntries.length > 0) {
        lines.push('current entries:')
        for (const entry of v.currentEntries) lines.push(`- ${entry}`)
      }
      if (v.done === true) lines.push('Stop retrying memory calls this turn.')
    } else {
      const target = v.target || 'memory'
      lines.push(`memory(${target}): ${v.message || 'Entry updated.'}`)
      if (v.usage !== undefined) lines.push(`usage: ${v.usage} (${v.entryCount || 0} entries)`)
      if (v.note !== undefined) lines.push(v.note)
    }
    return lines.join('\n')
  }

  // memory —— hermes 忠实移植
  ctx.effect(() => registerTool(
    'memory',
    [
      'Persistent self-maintained memory: bounded, durable notes that survive across sessions.',
      'MEMORY.md holds stable facts useful across sessions (environment and durable project conventions);',
      'USER.md holds what you know about the user (preferences, communication style, workflow habits).',
      'Both are re-injected as a frozen snapshot at each session start.',
      '',
      'Use `add` to persist a new durable fact, `replace` to merge or shorten an existing entry, `remove` to delete',
      'a stale entry; `patch` edits one unique span, `replace` replaces an entire entry for backwards compatibility; or `batch` to apply several operations atomically in one call (all-or-nothing: free space',
      'and add in the same call). `replace`/`remove` match entries by a short unique substring.',
      'Each store has a character budget; at capacity, consolidate in the same turn (replace overlapping entries',
      'with shorter ones or remove stale ones) and retry. Successful writes are final — do not repeat them.',
    ].join(' '),
    {
      action: { type: 'string', enum: ['add', 'patch', 'replace', 'remove', 'batch'], required: true, description: 'Add an entry, patch one unique span, replace a whole entry, remove an entry, or apply an atomic batch.' },
      target: { type: 'string', enum: ['memory', 'user'], description: 'Store to update. Defaults to memory (your personal notes). user = the user profile.' },
      content: { type: 'string', description: 'New entry text for add; new span for patch; whole replacement entry for replace.' },
      oldText: { type: 'string', description: 'For patch: exact span occurring once in one entry. For replace/remove: unique entry text or identifying substring.' },
      operations: { type: 'array', description: 'For action=batch: ordered operations applied all-or-nothing.', items: { type: 'object', additionalProperties: true, properties: { action: { type: 'string', enum: ['add', 'patch', 'replace', 'remove'] }, content: { type: 'string' }, oldText: { type: 'string' } } } },
    },
    renderWriteResult,
    async (args, exec) => {
      const target = args.target === 'user' ? 'user' : 'memory'
      const sessionId = sessionIdOf(exec)
      if (args.action === 'batch') {
        const operations = args.operations
        if (!Array.isArray(operations) || operations.length === 0) {
          return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, target, { success: false, target, error: "action='batch' requires a non-empty operations list." }, sessionId)
        }
        return await applyBatch(target, operations, sessionId)
      }
      const op = { action: args.action }
      if (args.content !== undefined) op.content = args.content
      if (args.oldText !== undefined) op.oldText = args.oldText
      return await applyBatch(target, [op], sessionId)
    },
  ))

  // memory_search —— 确定性关键词检索
  ctx.effect(() => registerTool(
    'memory_search',
    'Keyword-search the persistent memory banks (MEMORY.md personal notes and USER.md user profile). Deterministic substring scoring; use it when the injected snapshot lacks the detail you need.',
    {
      query: { type: 'string', required: true, description: 'Search terms.' },
      target: { type: 'string', enum: ['memory', 'user'], description: 'Bank to search; default both.' },
      limit: { type: 'number', description: 'Max results (1-20, default 10).' },
    },
    (v) => {
      if (v.count === 0) return `No memory entries matched "${v.query}".`
      return `Found ${v.count} entr(ies) for "${v.query}":\n` + v.results.map((r) => `- [${r.bank}] ${r.text}`).join('\n')
    },
    async (args, _exec) => {
      await ensureReady()
      const query = str(args.query).trim().toLowerCase()
      const banks = args.target === 'memory' || args.target === 'user' ? [args.target] : BANKS
      const results = []
      for (const bank of banks) {
        for (const entry of entriesOf(bank)) {
          const hay = entry.toLowerCase()
          let score = 0
          for (const tok of query.split(/\s+/).filter((w) => w.length > 0)) if (hay.includes(tok)) score += tok.length >= 4 ? 2 : 1
          if (score > 0) results.push({ bank, text: entry, score })
        }
      }
      results.sort((a, b) => b.score - a.score)
      const top = results.slice(0, Math.max(1, Math.min(args.limit || 10, 20)))
      return { query: args.query, count: top.length, results: top.map((r) => ({ bank: r.bank, text: r.text })) }
    },
  ))

  // memory_list
  ctx.effect(() => registerTool(
    'memory_list',
    'List the current entries of the persistent memory banks, in stored order.',
    {
      target: { type: 'string', enum: ['memory', 'user'], description: 'Bank to list; default both.' },
      limit: { type: 'number', description: 'Max entries per bank (1-100, default 50).' },
    },
    (v) => renderBankList(v, BANKS, HEADERS),
    async (args, _exec) => {
      await ensureReady()
      const limit = Math.max(1, Math.min(args.limit || 50, 100))
      const banks = args.target === 'memory' || args.target === 'user' ? [args.target] : BANKS
      const out = {}
      for (const bank of banks) out[bank] = entriesOf(bank).slice(0, limit)
      return { limit, usage: { memory: usageLine('memory'), user: usageLine('user') }, ...out }
    },
  ))

  // memory_stats
  ctx.effect(() => registerTool(
    'memory_stats',
    'Show persistent memory statistics: entries and character usage per bank, and the on-disk file location.',
    {},
    (v) => v.ready
      ? `Memory store: MEMORY.md ${v.memory.entries} entries (${v.memory.usage}); USER.md ${v.user.entries} entries (${v.user.usage}); file: ${v.file}`
      : `Memory store not ready: ${v.error}`,
    async (_args, _exec) => {
      try { await ensureReady() } catch (e) { return { ready: false, error: String((e && e.message) || e) } }
      return {
        ready: true,
        memory: { entries: entriesOf('memory').length, usage: usageLine('memory') },
        user: { entries: entriesOf('user').length, usage: usageLine('user') },
        file: '~/.dsh/storages/hermes_memory.json',
      }
    },
  ))

  // memory_debug —— 诊断工具（开发期排查句柄/存储状态用；可按需移除）
  ctx.effect(() => registerTool(
    'memory_debug',
    'Diagnostic: report the storage backend handle-table state and this plugin store state for the hermes_memory unit.',
    {},
    (v) => JSON.stringify(v, null, 2),
    async (_args, _exec) => {
      const backend = storageBackend()
      let handle = null
      let opening = null
      let unitClosed = null
      if (backend && backend.open && backend.open.get) {
        const unit = backend.open.get('hermes_memory')
        handle = unit !== undefined
        if (unit) unitClosed = unit.closed === true
      }
      if (backend && backend.opening && backend.opening.get) {
        opening = backend.opening.get('hermes_memory') !== undefined
      }
      return {
        backendPresent: backend !== undefined,
        handlePresent: handle,
        handleClosed: unitClosed,
        openingInFlight: opening,
        storeReady: store.ready,
        storeError: store.error,
        storeOpenAttempts: store.openAttempts,
        hasUnit: store.unit !== null,
      }
    },
  ))

  // ---------------- 冻结快照 + nudge 注入（agent/pre-step） ----------------
  function isOurMessage(event) {
    if (!event || event.type !== 'user/message') return false
    const source = event.data && event.data.source
    if (!source || source.kind !== 'plugin' || !PLUGIN_IDS.includes(source.plugin)) return false
    const blocks = event.data.content
    if (!Array.isArray(blocks)) return false
    return blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes(MARKER_SNAPSHOT))
  }
  function hasVisibleMemorySnapshot(events) {
    for (const event of events) if (isOurMessage(event)) return true
    return false
  }
  function turnsSinceMemoryWrite(events, sessionId) {
    const start = lastWriteEventCount.get(sessionId) ?? 0
    let turns = 0
    for (let i = start; i < events.length; i++) if (events[i].type === 'turn/start') turns += 1
    return turns
  }
  function renderMemoryBlock(bank) {
    const entries = entriesOf(bank)
    if (entries.length === 0) return ''
    const header = `${HEADERS[bank]} [${usageLine(bank)}]`
    const promptEntries = entries.map(entry => CONTENT_GUARD && scanMemoryContent(entry)
      ? '[Memory entry withheld by the content guard; review it in the memory panel.]' : entry)
    const content = escapeFrame(renderEntries(promptEntries))
    return `${RULER}\n${header}\n${RULER}\n${content}`
  }
  function renderSnapshotMessage() {
    const blocks = BANKS.map(renderMemoryBlock).filter((b) => b !== '')
    if (blocks.length === 0) blocks.push('Both persistent memory banks are empty at session start.')
    return [
      SYSTEM_REMINDER_OPEN,
      MARKER_SNAPSHOT,
      'Persistent memory, maintained with the `memory` tool. It was captured when this session started and does not change mid-session; entries persist across sessions.',
      'Use the `memory` tool to add durable facts (project conventions, environment quirks, things learned), to replace or shorten entries, and to remove stale ones.',
      '',
      blocks.join('\n\n'),
      SYSTEM_REMINDER_CLOSE,
    ].join('\n')
  }
  function renderNudgeMessage() {
    return [
      SYSTEM_REMINDER_OPEN,
      MARKER_NUDGE,
      `It has been ${NUDGE_INTERVAL} turns since you last updated persistent memory.`,
      'If this session produced durable facts worth keeping — project conventions, environment quirks, user preferences — call the `memory` tool now to persist them.',
      'Memory entries survive this session and are re-injected when a new session starts. If nothing is worth keeping, ignore this reminder.',
      SYSTEM_REMINDER_CLOSE,
    ].join('\n')
  }
  let messageCounter = 0
  function makeMessage(text) {
    messageCounter += 1
    return {
      id: `hermes-memory-${messageCounter}-${Date.now().toString(36)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    }
  }
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      payload.signal.throwIfAborted()
    } catch {
      return decision
    }
    const agent = payload.agent
    const sessionId = agent && agent.session ? String(agent.session.id) : null
    if (sessionId && payload.step === 1) failures.delete(sessionId)
    const messages = []
    try {
      const events = agent.session.events
      activeSessionEventCount.set(sessionId, events.length)
      // Bound per-session diagnostic/nudge state in long-lived deployments.
      if (activeSessionEventCount.size > 1000) {
        const oldest = activeSessionEventCount.keys().next().value
        activeSessionEventCount.delete(oldest); lastWriteEventCount.delete(oldest)
        failures.delete(oldest); lastNudgeTurn.delete(oldest)
      }
      if (!store.ready) {
        const now = Date.now()
        if (now - lastOpenAttemptAt >= 30000) {
          lastOpenAttemptAt = now
          await ensureReady()
        }
      }
      await store.chain

      if (store.ready && !hasVisibleMemorySnapshot(events)) {
        const text = renderSnapshotMessage()
        if (text !== '') messages.push(makeMessage(text))
      }
      // #2：nudge 去重 —— 同一会话每隔 NUDGE_INTERVAL 轮才提醒一次，
      // 避免连续 10 轮无写入后每轮刷屏
      if (NUDGE_INTERVAL > 0) {
        const lastN = lastNudgeTurn.get(sessionId)
        if ((lastN === undefined || payload.turn - lastN >= NUDGE_INTERVAL) && turnsSinceMemoryWrite(events, sessionId) >= NUDGE_INTERVAL) {
          messages.push(makeMessage(renderNudgeMessage()))
          lastNudgeTurn.set(sessionId, payload.turn)
        }
      }
    } catch (e) {
      console.error('[dsh-hermes-memory] pre-step fold failed:', e)
    }
    if (messages.length === 0) return decision
    // #10：防御 —— enter 决策消息数组判空
    const base = Array.isArray(decision.messages) ? decision.messages : []
    return { kind: 'enter', messages: [...base, ...messages] }
  })

  // ---------------- 太极记忆面板 HTTP API（client 半边同源 fetch） ----------------
  // Browser routes share the host owner authentication and origin fence.
  // webServer 的激活链依赖 webStartup，可能晚于本插件激活：先用 ctx.wait
  // 等待服务出现再注册（TUI 模式无 webServer，promise 永不 resolve，无副作用）。
  const registerPanelRoutes = (wsrv) => {
    const authorize = (req, res, method) => {
      const connection = ctx.get('connection')
      if (!connection || typeof connection.requestRejection !== 'function') {
        json(res, 503, { success: false, error: 'DSH authenticated connection service is unavailable' })
        return false
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        json(res, rejection, { success: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return false
      }
      if (req.method !== method) {
        res.setHeader('Allow', method)
        json(res, 405, { success: false, error: 'method not allowed' })
        return false
      }
      return true
    }
    const json = (res, code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const readBody = async (req) => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const encoder = new TextEncoder()
      let size = 0, raw = ''
      for await (const chunk of req) {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
        size += bytes.length
        if (size > 65536) throw Object.assign(new Error('body too large'), { status: 413 })
        raw += decoder.decode(bytes, { stream: true })
      }
      return raw + decoder.decode()
    }
    ctx.effect(() => wsrv.register({
      kind: 'exact',
      path: '/hermes-memory/stats',
      handler: async (req, res) => {
        if (!authorize(req, res, 'GET')) return
        try { await ensureReady(); await store.chain } catch (error) {
          json(res, 503, { ready: false, error: String(error.message || error) })
          return
        }
        const recent = []
        for (const bank of BANKS) {
          const recs = [...store.tables[bank].values()].sort((a, b) => b.seq - a.seq).slice(0, 3)
          for (const r of recs) recent.push({ bank, text: str(r.text).slice(0, 120), updatedAt: r.updatedAt })
        }
        json(res, 200, {
          ready: store.ready,
          error: store.error,
          memory: { entries: entriesOf('memory').length, usage: usageLine('memory') },
          user: { entries: entriesOf('user').length, usage: usageLine('user') },
          file: '~/.dsh/storages/hermes_memory.json',
          recent,
        })
      },
    }))
    ctx.effect(() => wsrv.register({
      kind: 'exact',
      path: '/hermes-memory/ops',
      handler: async (req, res) => {
        if (!authorize(req, res, 'POST')) return
        try {
          let input
          try { input = JSON.parse(await readBody(req)) } catch (error) {
            json(res, error.status || 400, { success: false, error: String(error.message || error) })
            return
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            json(res, 400, { success: false, error: 'Expected a JSON object' })
            return
          }
          if (input.bank !== undefined && !BANKS.includes(input.bank)) {
            json(res, 400, { success: false, error: 'Unknown memory bank' })
            return
          }
          await ensureReady()
          await store.chain
          const bank = input.bank === 'user' ? 'user' : 'memory'
          let op = null
          if (input.action === 'add') {
            op = { action: 'add', content: input.content }
          } else if (input.action === 'patch' || input.action === 'replace') {
            op = { action: input.action, oldText: input.oldText, content: input.content }
          } else if (input.action === 'remove') {
            op = { action: 'remove', oldText: input.oldText }
          } else if (input.action === 'batch') {
            if (!Array.isArray(input.operations)) {
              json(res, 400, { success: false, error: 'Expected an operations array' })
              return
            }
            const out = await applyBatch(bank, input.operations, 'ui')
            json(res, out.success ? 200 : 422, out)
            return
          }
          if (op !== null) {
            const out = await applyBatch(bank, [op], 'ui')
            json(res, out.success ? 200 : 422, out)
          } else if (input.action === 'list') {
            json(res, 200, {
              memory: entriesOf('memory').slice(0, 100),
              user: entriesOf('user').slice(0, 100),
              usage: { memory: usageLine('memory'), user: usageLine('user') },
            })
          } else {
            json(res, 400, { success: false, error: `unknown action: ${input.action}` })
          }
        } catch (e) {
          json(res, 500, { success: false, error: String((e && e.message) || e) })
        }
      },
    }))
  }
  // webServer 的激活链依赖 webStartup，可能晚于本插件激活：先直接取，
  // 取不到则每 500ms 轮询（本 cordis 版本无 ctx.wait）。TUI 等没有
  // webServer 的环境轮询 30 秒后自动放弃，仅缺面板 HTTP 层，工具与
  // 快照注入不受影响。注册失败打印日志，避免再次静默消失。
  const registerWhenReady = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined) return false
    try {
      registerPanelRoutes(ws)
    } catch (e) {
      console.error('[dsh-hermes-memory] panel route registration failed:', e)
    }
    return true
  }
  if (!registerWhenReady()) {
    let tries = 0
    const iv = setInterval(() => {
      tries += 1
      if (registerWhenReady() || tries >= 60) clearInterval(iv)
    }, 500)
    ctx.effect(() => () => clearInterval(iv))
  }
}

export default { name, Config, inject, apply }
