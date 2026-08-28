/**
 * dsh-hermes-memory — Hermes-style persistent memory for DeepSeek Harness.
 *
 * A faithful port of the hermes-agent `MemoryStore` mechanism
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
})

export const inject = ['tools']

export function apply(ctx, config) {
  // ---------------- 常量与状态 ----------------
  const BANKS = ['memory', 'user']
  const LIMITS = { memory: config.memoryCharLimit ?? 2200, user: config.userCharLimit ?? 1375 }
  const NUDGE_INTERVAL = config.nudgeInterval ?? 10
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
    error: null,
    openAttempts: 0,
  }
  const failures = new Map() // sessionId -> consolidation failure count this turn
  const lastNudgeTurn = new Map() // sessionId -> turn of the last injected nudge
  let lastOpenAttemptAt = 0 // 节流：存储重试间隔（ms）

  // ---------------- 工具函数 ----------------
  const enqueue = (task) => {
    const p = store.chain.then(task)
    store.chain = p.catch(() => {})
    return p
  }
  const entriesOf = (bank) => [...store.tables[bank].values()].sort((a, b) => a.seq - b.seq).map((r) => r.text)
  const charCount = (bank) => renderEntries(entriesOf(bank)).length
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

  // ---------------- 存储（带自愈） ----------------
  async function openStore(retried) {
    const backend = storageBackend()
    if (backend === undefined || backend.kv === undefined) throw new Error('json 存储后端不可用')
    let unit
    try {
      unit = await backend.kv.open({
        name: 'hermes_memory',
        version: 1,
        tables: BANKS,
        hasGlobal: false,
      })
    } catch (e) {
      const message = String((e && e.message) || e)
      // 自愈：句柄被僵尸单元占用 -> 强制关闭后重试一次
      if (!retried && message.includes('already open')) {
        const zombie = backend.open && backend.open.get('hermes_memory')
        console.error(`[dsh-hermes-memory] unit handle held by a stale owner; force-closing (open=${zombie !== undefined})`)
        if (zombie) await zombie.close().catch(() => {})
        return openStore(true)
      }
      throw e
    }
    const snap = await unit.loadAll()
    store.unit = unit
    for (const bank of BANKS) {
      const m = new Map()
      const records = (snap.tables && snap.tables[bank]) || {}
      let maxSeq = 0
      for (const k of Object.keys(records)) {
        const r = records[k]
        if (r && typeof r.text === 'string') {
          m.set(k, r)
          if (typeof r.seq === 'number' && r.seq > maxSeq) maxSeq = r.seq
        }
      }
      store.tables[bank] = m
      store.seq[bank] = maxSeq
    }
    store.ready = true
    store.openAttempts += 1
    console.log(`[dsh-hermes-memory] store opened (attempt #${store.openAttempts}): memory=${entriesOf('memory').length}, user=${entriesOf('user').length}`)
  }
  let initPromise = null
  function ensureReady() {
    if (store.ready) return Promise.resolve()
    if (initPromise === null) {
      initPromise = openStore(false).catch((e) => {
        store.error = String((e && e.message) || e)
        initPromise = null
        throw e
      })
    }
    return initPromise
  }
  ctx.effect(() => {
    ensureReady().catch(() => {})
    // disposer 返回 Promise：纤维销毁时等待 close 完成，避免关闭竞态
    return () => {
      const unit = store.unit
      store.unit = null
      if (unit) return unit.close().catch(() => {})
    }
  })

  function putRecord(bank, key, record) {
    return enqueue(async () => {
      await store.unit.putRecord(bank, key, record)
      store.tables[bank].set(key, record)
    })
  }
  function deleteRecord(bank, key) {
    return enqueue(async () => {
      await store.unit.deleteRecord(bank, key)
      store.tables[bank].delete(key)
    })
  }

  // ---------------- 合并协议（核心逻辑在 core.js，此处只做编排） ----------------
  async function applyBatch(bank, operations, sessionId) {
    await ensureReady()
    if (operations.length === 0) {
      return { success: false, target: bank, error: 'operations list is empty.' }
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
    if (renderEntries(working.map((w) => w.text)).length > limit) {
      return consolidationFailure(failures, MAX_CONSOLIDATION_FAILURES, bank, {
        success: false,
        target: bank,
        error: [
          `After applying all ${operations.length} operations, memory would be at`,
          `${renderEntries(working.map((w) => w.text)).length.toLocaleString()}/${limit.toLocaleString()} chars — over the limit.`,
          'Remove or shorten more entries in the same batch (see current_entries below), then retry.',
        ].join(' '),
        currentEntries: entriesOf(bank),
        usage: usageLine(bank),
      }, sessionId)
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
    for (const t of tasks) {
      if (t.kind === 'del') await deleteRecord(t.bank, t.key)
      else await putRecord(t.bank, t.key, t.record)
    }
    // 提交成功：把局部计数器的最终值写回全局 seq
    store.seq[bank] = seqCounter.next - 1
    failures.delete(sessionId)
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
      'MEMORY.md holds your personal notes (environment facts, project conventions, tool quirks, things learned);',
      'USER.md holds what you know about the user (preferences, communication style, workflow habits).',
      'Both are re-injected as a frozen snapshot at each session start.',
      '',
      'Use `add` to persist a new durable fact, `replace` to merge or shorten an existing entry, `remove` to delete',
      'a stale entry, or `batch` to apply several operations atomically in one call (all-or-nothing: free space',
      'and add in the same call). `replace`/`remove` match entries by a short unique substring.',
      'Each store has a character budget; at capacity, consolidate in the same turn (replace overlapping entries',
      'with shorter ones or remove stale ones) and retry. Successful writes are final — do not repeat them.',
    ].join(' '),
    {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'batch'], required: true, description: 'What to do: add one entry, replace or remove entries matched by substring, or apply a batch atomically.' },
      target: { type: 'string', enum: ['memory', 'user'], description: 'Store to update. Defaults to memory (your personal notes). user = the user profile.' },
      content: { type: 'string', description: 'New entry text for add; replacement text for replace; per-operation content in batch.' },
      oldText: { type: 'string', description: 'Short unique substring of the entry to replace or remove.' },
      operations: { type: 'array', description: 'For action=batch: ordered operations applied all-or-nothing.', items: { type: 'object', additionalProperties: true, properties: { action: { type: 'string', enum: ['add', 'replace', 'remove'] }, content: { type: 'string' }, oldText: { type: 'string' } } } },
    },
    renderWriteResult,
    async (args, exec) => {
      const target = args.target === 'user' ? 'user' : 'memory'
      const sessionId = sessionIdOf(exec)
      if (args.action === 'batch') {
        const operations = args.operations
        if (!Array.isArray(operations) || operations.length === 0) {
          return { success: false, target, error: "action='batch' requires a non-empty operations list." }
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
  function turnsSinceMemoryWrite(events) {
    let turns = 0
    for (const event of events) {
      if (event.type === 'turn/start') turns += 1
      else if (event.type === 'tool/call' && event.data && event.data.name === 'memory') turns = 0
    }
    return turns
  }
  function renderMemoryBlock(bank) {
    const entries = entriesOf(bank)
    if (entries.length === 0) return ''
    const header = `${HEADERS[bank]} [${usageLine(bank)}]`
    const content = escapeFrame(renderEntries(entries))
    return `${RULER}\n${header}\n${RULER}\n${content}`
  }
  function renderSnapshotMessage() {
    const blocks = BANKS.map(renderMemoryBlock).filter((b) => b !== '')
    if (blocks.length === 0) return ''
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
    if (sessionId) failures.delete(sessionId)
    const messages = []
    try {
      const events = agent.session.events
      // #6：存储未就绪时按节流间隔补一次重试（避免每轮重试确定坏掉的后端，
      // 也避免首次 open 失败后快照永久静默缺失）
      if (!store.ready) {
        const t = Date.now()
        if (t - lastOpenAttemptAt > 30000) {
          lastOpenAttemptAt = t
          ensureReady().catch(() => {})
        }
      }
      if (store.ready && !hasVisibleMemorySnapshot(events)) {
        const text = renderSnapshotMessage()
        if (text !== '') messages.push(makeMessage(text))
      }
      // #2：nudge 去重 —— 同一会话每隔 NUDGE_INTERVAL 轮才提醒一次，
      // 避免连续 10 轮无写入后每轮刷屏
      if (NUDGE_INTERVAL > 0) {
        const lastN = lastNudgeTurn.get(sessionId)
        if ((lastN === undefined || payload.turn - lastN >= NUDGE_INTERVAL) && turnsSinceMemoryWrite(events) >= NUDGE_INTERVAL) {
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
  // 为浏览器 UI 提供只读统计与删除操作；同一进程内信任边界，不做鉴权。
  // webServer 的激活链依赖 webStartup，可能晚于本插件激活：先用 ctx.wait
  // 等待服务出现再注册（TUI 模式无 webServer，promise 永不 resolve，无副作用）。
  const registerPanelRoutes = (wsrv) => {
    const json = (res, code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    const readBody = async (req) => {
      let raw = ''
      for await (const chunk of req) {
        if (raw.length > 65536) throw new Error('body too large')
        raw += chunk
      }
      return raw
    }
    ctx.effect(() => wsrv.register({
      kind: 'exact',
      path: '/hermes-memory/stats',
      handler: async (_req, res) => {
        try { await ensureReady() } catch { /* fall through */ }
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
        try {
          const input = JSON.parse(await readBody(req))
          const bank = input.bank === 'user' ? 'user' : 'memory'
          let op = null
          if (input.action === 'add') {
            op = { action: 'add', content: String(input.content ?? '') }
          } else if (input.action === 'replace') {
            op = { action: 'replace', oldText: String(input.oldText ?? ''), content: String(input.content ?? '') }
          } else if (input.action === 'remove') {
            op = { action: 'remove', oldText: String(input.oldText ?? '') }
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
