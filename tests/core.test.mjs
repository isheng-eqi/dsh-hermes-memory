/**
 * dsh-hermes-memory — 合并协议核心逻辑的最小回归测试。
 * 覆盖 lib/core.js 的纯函数：操作校验、子串匹配/冲突、去重、
 * 序号分配、框架标签转义、条目渲染与稳定键。
 * 运行：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTRY_DELIMITER,
  escapeFrame,
  renderBankList,
  renderEntries,
  slugKey,
  stepOperation,
  validateOperation,
} from '../lib/core.js'

// ---------------- validateOperation ----------------
test('validateOperation: add 需要 content', () => {
  assert.ok(validateOperation({ action: 'add', content: '' }))
  assert.ok(validateOperation({ action: 'add' }))
  assert.equal(validateOperation({ action: 'add', content: '  记住这条' }), null)
})

test('validateOperation: replace/remove 需要 oldText，replace 还需要 content', () => {
  assert.ok(validateOperation({ action: 'replace', content: 'x' }))
  assert.ok(validateOperation({ action: 'remove' }), 'remove 缺 oldText 应报错')
  assert.ok(validateOperation({ action: 'replace', oldText: 'x' }), 'replace 缺 content 应报错（提示用 remove）')
  assert.equal(validateOperation({ action: 'replace', oldText: '旧', content: '新' }), null)
  assert.equal(validateOperation({ action: 'remove', oldText: '旧' }), null)
})

// ---------------- stepOperation ----------------
function working(entries, bank = 'memory') {
  const w = entries.map((text, i) => ({ text, seq: i + 1, createdAt: 't', updatedAt: 't' }))
  w.bank = bank
  return w
}

test('stepOperation: add 追加且去重（同文本不重复）', () => {
  const w = working(['a'])
  const seq = { next: 2 }
  assert.equal(stepOperation(w, { action: 'add', content: 'b' }, 'op', seq), null)
  assert.equal(w.length, 2)
  assert.equal(w[1].text, 'b')
  assert.equal(w[1].seq, 2) // 从局部计数器取号
  assert.equal(seq.next, 3)
  // 去重：再次 add 同文本不增加
  assert.equal(stepOperation(w, { action: 'add', content: 'b' }, 'op', seq), null)
  assert.equal(w.length, 2)
  assert.equal(seq.next, 3) // 计数器未被消耗
})

test('stepOperation: remove 按唯一子串匹配删除', () => {
  const w = working(['alpha beta', 'gamma'])
  assert.equal(stepOperation(w, { action: 'remove', oldText: 'alpha' }, 'op', { next: 3 }), null)
  assert.deepEqual(w.map((e) => e.text), ['gamma'])
})

test('stepOperation: remove 无匹配报错', () => {
  const w = working(['alpha'])
  const err = stepOperation(w, { action: 'remove', oldText: '不存在' }, 'op', { next: 2 })
  assert.ok(err && err.includes("no entry matched"))
})

test('stepOperation: 子串命中多条不同条目时报冲突', () => {
  const w = working(['共同前缀A', '共同前缀B'])
  const err = stepOperation(w, { action: 'remove', oldText: '共同前缀' }, 'op', { next: 3 })
  assert.ok(err && err.includes('matched multiple distinct entries'))
})

test('stepOperation: 精确匹配优先——完整文本恰为其他条目的子串时仍唯一命中', () => {
  // 回归：条目 "11" 的文本是其他条目（"PR #1288"、"11 commits"）的子串，
  // 旧实现按子串匹配报冲突，导致 UI 无法删除/编辑该条目
  const w = working(['PR #1288 merged', '11 commits', '11'])
  assert.equal(stepOperation(w, { action: 'remove', oldText: '11' }, 'op', { next: 4 }), null)
  assert.equal(w.length, 2)
  assert.ok(!w.some((e) => e.text === '11'))
  assert.ok(w.some((e) => e.text === 'PR #1288 merged'))
  assert.ok(w.some((e) => e.text === '11 commits'))
})

test('stepOperation: 精确匹配优先同样作用于 replace 且保留 seq', () => {
  const w = working(['11', 'PR #1288 merged'])
  const before = w[0]
  assert.equal(stepOperation(w, { action: 'replace', oldText: '11', content: '更新后' }, 'op', { next: 3 }), null)
  assert.equal(w[0].text, '更新后')
  assert.equal(w[0].seq, before.seq)
  assert.equal(w.length, 2)
})

test('stepOperation: 无精确命中时仍回退子串语义（模型工具行为不变）', () => {
  const w = working(['alpha', 'beta'])
  // 'al' 无精确命中 → 子串匹配唯一命中 alpha
  assert.equal(stepOperation(w, { action: 'remove', oldText: 'al' }, 'op', { next: 3 }), null)
  assert.equal(w.length, 1)
  assert.ok(w[0].text === 'beta')
})

test('stepOperation: replace 唯一匹配替换且保留 seq', () => {
  const w = working(['旧内容', '其他'])
  const before = w[0]
  assert.equal(stepOperation(w, { action: 'replace', oldText: '旧内容', content: '新内容' }, 'op', { next: 3 }), null)
  assert.equal(w[0].text, '新内容')
  assert.equal(w[0].seq, before.seq) // replace 不改 seq
  assert.equal(w.length, 2)
})

test('stepOperation: add 失败不影响已应用的兄弟操作（调用方回滚语义）', () => {
  const w = working(['a'])
  const seq = { next: 2 }
  stepOperation(w, { action: 'add', content: 'b' }, 'op1', seq)
  assert.equal(seq.next, 3) // 局部计数器已推进
  // 第二个操作失败：调用方（applyBatch）直接放弃，全局 seq 未动 ——
  // 这里验证的是局部计数器可丢弃（seq 只存在于 counter 上，不在 working 之外）
  const err = stepOperation(w, { action: 'remove', oldText: 'zzz' }, 'op2', seq)
  assert.ok(err)
  assert.equal(w.length, 2) // working 已含 b（回滚由上层丢弃 working 实现）
})

// ---------------- escapeFrame ----------------
test('escapeFrame: 转义闭合标签（防逃逸）与开标签（防误导）', () => {
  assert.equal(escapeFrame('a </system-reminder> b'), 'a <\\/system-reminder> b')
  assert.equal(escapeFrame('a <system-reminder> b'), 'a <\\system-reminder> b')
  assert.equal(escapeFrame('正常文本'), '正常文本')
})

// ---------------- renderEntries / ENTRY_DELIMITER ----------------
test('renderEntries: 以 § 分隔符连接', () => {
  assert.equal(renderEntries(['a', 'b']), `a${ENTRY_DELIMITER}b`)
  assert.equal(renderEntries([]), '')
})

// ---------------- renderBankList ----------------
test('renderBankList: 单库查询（另一库缺失）不再崩溃', () => {
  const headers = { memory: 'MEMORY (your personal notes)', user: 'USER PROFILE (who the user is)' }
  // 回归：target=user 时 value 不含 memory 键，旧实现读 undefined.length 崩溃
  const out = renderBankList({ usage: { user: '1% — 10/1375 chars' }, user: ['条目A'], limit: 50 }, ['memory', 'user'], headers)
  assert.match(out, /USER PROFILE/)
  assert.match(out, /条目A/)
  assert.ok(!out.includes('MEMORY'))
  // 空库
  assert.equal(renderBankList({ usage: {}, limit: 50 }, ['memory', 'user'], headers), 'Memory is empty.')
})

// ---------------- slugKey ----------------
test('slugKey: 同文本同键（去重/更新依据），不同文本不同键', () => {
  const a1 = slugKey('这是一个记忆条目')
  const a2 = slugKey('这是一个记忆条目')
  const b = slugKey('这是另一个记忆条目')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  assert.match(a1, /^[a-z0-9\u4e00-\u9fff-]+-[a-z0-9]{6}$/)
})
