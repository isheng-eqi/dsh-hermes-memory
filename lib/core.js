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

/** 形状校验一个操作；返回失败说明或 null。 */
export function validateOperation(op) {
  const content = str(op.content).trim()
  const oldText = str(op.oldText).trim()
  if (op.action === 'add') {
    if (content === '') return 'content is required.'
  } else {
    if (oldText === '') return 'old_text is required.'
    if (op.action === 'replace' && content === '') {
      return "content is required (use action='remove' to delete)."
    }
  }
  return null
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
  const content = str(op.content).trim()
  const oldText = str(op.oldText).trim()
  if (op.action === 'add') {
    if (!working.some((e) => e.text === content)) {
      working.push({ text: content, seq: seqCounter.next++, createdAt: now(), updatedAt: now() })
    }
    return null
  }
  // 精确匹配优先（UI 传完整文本时永远唯一命中，即使该文本是其他条目的
  // 子串——回归：条目 "11" 曾被其他含 "11" 的条目干扰而无法删除/编辑）；
  // 无精确命中时回退 Hermes 原版子串语义（模型 memory 工具行为不变）。
  let matches = working
    .map((entry, index) => ({ entry, index }))
    .filter((c) => c.entry.text === oldText)
  if (matches.length === 0) {
    matches = working
      .map((entry, index) => ({ entry, index }))
      .filter((c) => c.entry.text.includes(oldText))
  }
  if (matches.length === 0) return `${pos}: no entry matched '${oldText}'.`
  if (new Set(matches.map((m) => m.entry.text)).size > 1) {
    return `${pos}: '${oldText}' matched multiple distinct entries — be more specific.`
  }
  if (op.action === 'replace') {
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
