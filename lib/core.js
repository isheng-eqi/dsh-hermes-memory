/**
 * dsh-hermes-memory — 纯逻辑核心（零依赖，可独立测试）。
 *
 * 本模块是合并协议与渲染逻辑的权威实现，被 `lib/index.js`（静态 bundle）
 * 引用；`host.js`（动态插件镜像）因运行在 node:vm sandbox 中无法 import，
 * 只能复制本文件内容——改本文件时务必同步 host.js 中对应函数。
 *
 * 所有函数均为纯函数（除 `now` 读取系统时钟），不接触 store、ctx 或任何
 * DSH 服务，可直接被 node:test 覆盖（tests/core.test.mjs）。
 */

/** 条目分隔符（与 hermes-agent MemoryStore 一致）。 */
export const ENTRY_DELIMITER = '\n§\n'

/** 每轮合并失败上限（hermes-agent 契约）。 */
export const MAX_CONSOLIDATION_FAILURES = 3

/** 字符串化辅助（undefined/null → ''）。 */
export const str = (v) => (v === undefined || v === null ? '' : String(v))

/** ISO 时间戳。 */
export const now = () => new Date().toISOString()

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * 转义记忆条目中的 system-reminder 标签，防止文件内容闭合/伪造插件拥有的
 * 注入框架。闭合标签是真正的逃逸向量（Hermes 原版只处理它）；开标签虽
 * 不能破坏框架，但会误导模型对框架边界的判断，一并转义。
 */
export function escapeFrame(text) {
  return String(text)
    .replaceAll(SYSTEM_REMINDER_OPEN, '<\\system-reminder>')
    .replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

/** 按条目分隔符连接条目（文件存储/渲染使用的同一形式）。 */
export function renderEntries(entries) {
  return entries.join(ENTRY_DELIMITER)
}

/** Internal operation validation. `replace` remains solely for legacy panel editing. */
export function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'operation must be an object.'
  if (!['add', 'patch', 'replace', 'remove'].includes(op.action)) return 'unknown memory action.'
  if (op.content !== undefined && typeof op.content !== 'string') return 'content must be a string.'
  const old = op.oldText ?? op.old_text
  if (old !== undefined && typeof old !== 'string') return 'old_text must be a string.'
  if (op.matched_entry !== undefined && typeof op.matched_entry !== 'string') return 'matched_entry must be a string.'
  if (op.action === 'add') {
    if (str(op.content).trim() === '') return 'content is required.'
  } else {
    if (str(old).trim() === '') return 'old_text is required.'
    if (['patch', 'replace'].includes(op.action) && str(op.content).trim() === '') {
      return "content is required (use action='remove' to delete an entire entry)."
    }
  }
  return null
}

/** Normalize the public Hermes call to the existing internal operation representation. */
export function normalizeMemoryCall(args, enabledBanks = ['memory', 'user']) {
  const invalid = error => ({ success: false, error })
  if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid('Memory arguments must be an object.')
  if (args.target === undefined || args.target === null) return invalid("Missing required target. Set target='memory' or target='user' at the top level.")
  if (!['memory', 'user'].includes(args.target)) return invalid("Invalid memory target. Use 'memory' or 'user'.")
  const enabled = Array.isArray(enabledBanks) ? enabledBanks : ['memory', 'user'].filter(bank => enabledBanks?.[bank] !== false)
  if (!enabled.includes(args.target)) return invalid(`Built-in ${args.target === 'memory' ? 'MEMORY.md' : 'USER.md'} writes are disabled in memory config.`)
  const hasOperations = args.operations !== undefined && args.operations !== null
  if (hasOperations && !Array.isArray(args.operations)) return invalid('operations must be a list of {action, content?, old_text?} objects.')
  let input = args.operations
  if (!input?.length) {
    if (!args.action || args.action === 'batch') return invalid("Missing required parameter: 'operations', a non-empty list of {action: add/patch/remove, content?, old_text?} changes.")
    input = [args]
  }
  const operations = []
  for (let index = 0; index < input.length; index++) {
    const source = input[index]
    if (!source || typeof source !== 'object' || Array.isArray(source)) return invalid(`Operation ${index + 1} must be an object.`)
    if (source.target !== undefined && source.target !== null && source.target !== args.target) return invalid(`Operation ${index + 1} names a different target. One call writes one store; use separate calls for different stores.`)
    if (source.action === 'replace') return invalid("'replace' has been removed. Use 'patch' with old_text equal to the full entry to replace the whole entry; shorter old_text edits only that span.")
    if (!['add', 'patch', 'remove'].includes(source.action)) return invalid(`Operation ${index + 1}: unknown action. Use add, patch, remove.`)
    for (const field of ['content', 'new_text', 'newText', 'old_text', 'oldText']) {
      if (source[field] !== undefined && source[field] !== null && typeof source[field] !== 'string') return invalid(`Operation ${index + 1}: ${field} must be a string.`)
    }
    const content = source.content || source.new_text || source.newText
    const oldText = source.old_text ?? source.oldText
    const operation = { action: source.action }
    if (content !== undefined) operation.content = content
    if (oldText !== undefined) operation.oldText = oldText
    if (source.matched_entry !== undefined) operation.matched_entry = source.matched_entry
    const problem = validateOperation(operation)
    if (problem) return invalid(`Operation ${index + 1}: ${problem} Nothing was written or staged.`)
    if (source.action === 'add') operation.content = operation.content.trim()
    if (source.action === 'remove') operation.oldText = operation.oldText.trim()
    operations.push(operation)
  }
  return { success: true, target: args.target, operations }
}

/** Final-result guards, after all operations have been applied to a private copy. */
export function validateFinalBatch(beforeEntries, afterEntries, operations, limit) {
  const texts = entries => entries.map(entry => typeof entry === 'string' ? entry : entry.text)
  const before = texts(beforeEntries)
  const after = texts(afterEntries)
  const singleRemove = operations.length === 1 && operations[0].action === 'remove'
  if (before.length > 0 && after.length === 0 && !singleRemove) {
    return 'Refusing to empty a non-empty memory store by consolidation. Preserve useful entries; a single explicit remove may delete the final entry.'
  }
  const count = countChars(renderEntries(after))
  const removeOnly = operations.length > 0 && operations.every(operation => operation.action === 'remove')
  const duplicateAdd = operations.length === 1 && operations[0].action === 'add'
    && before.includes(str(operations[0].content).trim()) && before.length === after.length
    && before.every((entry, index) => entry === after[index])
  if (count > limit && !removeOnly && !duplicateAdd) return `Final memory would use ${count.toLocaleString()}/${limit.toLocaleString()} chars. Shorten stale entries or remove less important entries in the same batch.`
  return null
}

/** Quote/dash/whitespace fold used only to locate an entry, never to rewrite its text. */
export function normalizeForMatch(text) {
  return String(text).replaceAll('\\n', ' ')
    .replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/gu, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu, '-')
    .replace(/\s+/gu, ' ').trim()
}

/** Full exact entry wins; then exact substring; finally tolerant typography. */
export function findEntryMatches(entries, oldText) {
  let matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.text === oldText)
  if (!matches.length) matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.text.includes(oldText))
  if (!matches.length) {
    const needle = normalizeForMatch(oldText)
    if (!/[\p{L}\p{N}]/u.test(needle)) return []
    matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => normalizeForMatch(entry.text).includes(needle))
  }
  return matches
}

/**
 * Hermes 合并失败协议：同一会话每轮最多失败 `max` 次，超出后返回"停止
 * 重试"文案（给模型防死循环，`failures` 是调用方持有的 Map：sessionId →
 * 本轮失败次数）。面板 UI 调用（sessionId='ui'）不参与计数——UI 每次失败
 * 都应看到原始错误，且 'ui' 计数没有会话级清理点，一旦达到上限会永久
 * 卡死所有面板操作（回归：'11' 冲突连续失败 4 次后，面板任何操作都返回
 * consolidation 文案）。
 */
export function consolidationFailure(failures, max, bank, response, sessionId) {
  if (sessionId === 'ui') return response
  const count = (failures.get(sessionId) || 0) + 1
  failures.set(sessionId, count)
  if (count <= max) return response
  return {
    ...response,
    success: false,
    done: true,
    error: [
      `Memory consolidation failed ${count} times this turn.`,
      'Stop retrying memory calls — leave memory unchanged for now and continue with your reply to the user.',
      'The fact can be saved in a later turn.',
    ].join(' '),
  }
}

/**
 * 对一个 working 副本应用一个已校验的操作；null ⇒ 已应用。
 *
 * `seqCounter` 是 { next } 形式的局部序号计数器：add 从它取号，避免直接
 * 修改全局 seq——若后续操作失败/超限导致整个 batch 回滚，全局序号不会被
 * 污染（跳号虽不破坏正确性，但保持"失败无副作用"更干净）。提交成功后由
 * 调用方把 `seqCounter.next - 1` 写回全局 seq。
 */
export function stepOperation(working, op, pos, seqCounter) {
  const content = op.action === 'patch' ? str(op.content) : str(op.content).trim()
  const oldText = op.action === 'patch' ? str(op.oldText ?? op.old_text) : str(op.oldText ?? op.old_text).trim()
  if (op.action === 'add') {
    if (!working.some((e) => e.text === content)) {
      if (!Number.isSafeInteger(seqCounter.next) || seqCounter.next < 1) return pos + ': memory sequence is exhausted; no operations were applied.'
      working.push({ text: content, seq: seqCounter.next++, createdAt: now(), updatedAt: now() })
    }
    return null
  }
  // 精确匹配优先（UI 传完整文本时永远唯一命中，即使该文本是其他条目的
  // 子串——回归：条目 "11" 曾被其他含 "11" 的条目干扰而无法删除/编辑）；
  // 无精确命中时回退 Hermes 原版子串语义（模型 memory 工具行为不变）。
  const pinned = op.matched_entry !== undefined
  const matches = pinned
    ? working.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.text === op.matched_entry)
    : findEntryMatches(working, oldText)
  if (matches.length === 0) return pinned
    ? `${pos}: the entry changed since approval was requested; nothing was applied.`
    : `${pos}: no entry matched '${oldText}'.`
  if (new Set(matches.map((m) => m.entry.text)).size > 1) {
    return `${pos}: '${oldText}' matched multiple distinct entries — be more specific.`
  }
  if (op.action === 'patch') {
    const entry = matches[0].entry.text
    const start = entry.indexOf(oldText)
    if (start === -1) return pos + ': old_text located an entry through typography matching, but patch needs the exact stored span. Copy old_text verbatim from the entry.'
    if (entry.indexOf(oldText, start + 1) !== -1) return pos + ': oldText occurs more than once in the entry; include more context.'
    const text = entry.slice(0, start) + content + entry.slice(start + oldText.length)
    if (text === entry) return pos + ': patch leaves the entry unchanged.'
    working[matches[0].index] = { ...matches[0].entry, text, updatedAt: now() }
  } else if (op.action === 'replace') {
    working[matches[0].index] = { ...working[matches[0].index], text: content, updatedAt: now() }
  } else {
    working.splice(matches[0].index, 1)
  }
  return null
}

/** 从文本生成稳定键（同文本 ⇒ 同键 ⇒ 去重/更新而非重复）。 */
export function slugKey(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = (h ^ text.charCodeAt(i)) * 16777619 >>> 0
  const stem = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'e'
  return `${stem}-${h.toString(36).slice(0, 6)}`
}

/**
 * memory_list 的渲染：按库渲染条目列表。
 * `value` 只包含请求的库（单库查询时另一库为 undefined），因此对每个库
 * 做数组判空——缺失/空库跳过（回归：单库查询曾因读取 undefined.length 崩溃）。
 */
export function renderBankList(value, banks, headers) {
  const lines = []
  for (const bank of banks) {
    const entries = value[bank]
    if (!Array.isArray(entries) || entries.length === 0) continue
    lines.push(`${headers[bank]} [${value.usage[bank]}]`)
    for (const e of entries.slice(0, value.limit)) lines.push(`- ${e}`)
  }
  return lines.length ? lines.join('\n') : 'Memory is empty.'
}

/** Python len parity: astral characters count once; combining marks remain separate. */
export const countChars = text => Array.from(text).length

/**
 * Deterministic content guard adapted from Hermes tools/threat_patterns.py
 * (NousResearch/hermes-agent, MIT, upstream 0f0e96fc). No network or LLM calls.
 * Deliberately bounded; this is a heuristic, not a complete injection detector.
 */
export function scanMemoryContent(content) {
  let raw = '', scanned = 0
  for (const point of content) { if (scanned++ >= 65536) break; raw += point }
  // ZWJ/ZWNJ are valid emoji and natural-language characters.
  const invisible = raw.match(/[\u200b\u2060\u2062\u2063\u2064\ufeff\u202a-\u202e\u2066-\u2069]/u)
  if (invisible) return 'invisible_unicode_U+' + invisible[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  // Keep line boundaries, collapse horizontal whitespace before regex evaluation.
  // Avoid overlapping variable-length whitespace matches on adversarial padding.
  const text = raw.normalize('NFKC').replace(/[^\S\n]+/gu, ' ')
  const filler = '(?:\\w+\\s+){0,8}'
  const secret = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`
  const patterns = [
    ['prompt_injection', new RegExp('ignore\\s+' + filler + '(previous|all|above|prior)\\s+' + filler + 'instructions', 'i')],
    ['sys_prompt_override', /system\s+prompt\s+override/i],
    ['disregard_rules', new RegExp('disregard\\s+' + filler + '(your|all|any)\\s+' + filler + '(instructions|rules|guidelines)', 'i')],
    ['bypass_restrictions', /act\s+as\s+(if|though)\s+(?:\w+\s+){0,8}you\s+(?:\w+\s+){0,8}(have\s+no|don't\s+have)\s+(?:\w+\s+){0,8}(restrictions|limits|rules)/i],
    ['html_comment_injection', /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i],
    ['hidden_div', /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i],
    ['translate_execute', /translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b/i],
    ['deception_hide', new RegExp('do\\s+not\\s+' + filler + 'tell\\s+' + filler + 'the\\s+user', 'i')],
    ['role_hijack', /you\s+are\s+(?:\w+\s+){0,8}now\s+(?:a|an|the)\s+/i],
    ['role_pretend', /pretend\s+(?:\w+\s+){0,8}(you\s+are|to\s+be)\s+/i],
    ['leak_system_prompt', /output\s+(?:\w+\s+){0,8}(system|initial)\s+prompt/i],
    ['remove_filters', /(respond|answer|reply)\s+without\s+(?:\w+\s+){0,8}(restrictions|limitations|filters|safety)/i],
    ['fake_update', /you\s+have\s+been\s+(?:\w+\s+){0,8}(updated|upgraded|patched)\s+to/i],
    ['identity_override', /\bname\s+yourself\s+\w+/i],
    ['c2_node_registration', /register\s+(as\s+)?a?\s*node/i],
    ['c2_heartbeat', /(heartbeat|beacon|check[\s-]?in)\s+(to|with)\s+/i],
    ['c2_task_pull', /pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b/i],
    ['c2_network_connect', /connect\s+to\s+the\s+network\b/i],
    ['forced_action', /you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b/i],
    ['anti_forensic_oneliner', /only\s+use\s+one[\s-]?liners?\b/i],
    ['anti_forensic_disk', /never\s+(?:\w+\s+){0,8}(?:create|write)\s+(?:\w+\s+){0,8}(?:script|file)\s+(?:\w+\s+){0,8}disk/i],
    ['env_var_unset_agent', /unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i],
    ['known_c2_framework', /\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i],
    ['c2_explicit', /\bc2\s+(?:server|channel|infrastructure|beacon)\b/i],
    ['c2_explicit_long', /\bcommand\s+and\s+control\b/i],
    ['exfil_curl', new RegExp('curl\\s+[^\\n]{0,2048}' + secret, 'i')],
    ['exfil_wget', new RegExp('wget\\s+[^\\n]{0,2048}' + secret, 'i')],
    ['read_secrets', /cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i],
    ['send_to_url', /(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?:\/\//i],
    ['context_exfil', /(include|output|print|share)\s+(?:\w+\s+){0,8}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)/i],
    ['ssh_backdoor', /(?:append|add|write|echo|tee|>>?) [^\n]{0,512}authorized_keys/i],
    ['ssh_access', /(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME\/\.ssh|~\/\.ssh)/i],
    ['hermes_env', /\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/i],
    ['agent_config_mod', /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)/i],
    ['hermes_config_mod', /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.hermes\/(config\.yaml|SOUL\.md)/i],
  ]
  for (const [id, pattern] of patterns) if (pattern.test(text)) return id
  const secrets = text.matchAll(/(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi)
  for (const match of secrets) if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(match[1])) return 'hardcoded_secret'
  return null
}
