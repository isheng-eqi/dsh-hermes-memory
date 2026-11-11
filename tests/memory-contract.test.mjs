import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeMemoryCall, validateFinalBatch, stepOperation, validateOperation,
  normalizeForMatch,
} from '../lib/core.js'
import {
  UPSTREAM_COMMIT, MEMORY_GUIDANCE, MEMORY_REVIEW_PROMPT,
  createMemoryToolParameters, createMemoryToolDescription,
} from '../lib/prompts.js'

const records = values => values.map((text, index) => ({ text, seq: index + 1 }))

test('public call requires one explicit enabled target and normalizes same-store operations', () => {
  assert.match(normalizeMemoryCall({ operations: [{ action: 'add', content: 'x' }] }).error, /required target/)
  assert.equal(normalizeMemoryCall({ target: 'all', action: 'add', content: 'x' }).success, false)
  assert.match(normalizeMemoryCall({ target: 'memory', action: 'add', content: 'x' }, ['user']).error, /disabled/)
  assert.equal(normalizeMemoryCall({ target: 'user', operations: [{ target: 'memory', action: 'add', content: 'x' }] }).success, false)
  assert.deepEqual(normalizeMemoryCall({ target: 'user', operations: [{ target: 'user', action: 'add', content: '  x  ' }] }), {
    success: true, target: 'user', operations: [{ action: 'add', content: 'x' }],
  })
})

test('legacy call and aliases remain compatible while public replace is rejected', () => {
  assert.deepEqual(normalizeMemoryCall({ target: 'memory', action: 'patch', old_text: 'tea ', new_text: 'coffee ' }), {
    success: true, target: 'memory', operations: [{ action: 'patch', oldText: 'tea ', content: 'coffee ' }],
  })
  assert.deepEqual(normalizeMemoryCall({ target: 'memory', action: 'remove', oldText: ' x ' }).operations, [{ action: 'remove', oldText: 'x' }])
  assert.deepEqual(normalizeMemoryCall({ target: 'memory', action: 'patch', oldText: 'x', content: '', new_text: 'y' }).operations, [{ action: 'patch', oldText: 'x', content: 'y' }])
  assert.match(normalizeMemoryCall({ target: 'memory', action: 'replace', oldText: 'x', content: 'y' }).error, /removed/)
  assert.equal(validateOperation({ action: 'replace', oldText: 'x', content: 'y' }), null)
})

test('invalid arguments are rejected before applying a batch', () => {
  for (const operations of ['x', {}, [null], [[]], [{ action: 'add', content: 7 }], [{ action: 'remove' }], [{ action: 'patch', old_text: 'x', content: ' ' }], [{ action: 'add', content: false }]]) {
    assert.equal(normalizeMemoryCall({ target: 'memory', operations }).success, false)
  }
  assert.equal(normalizeMemoryCall({ target: 'memory', operations: [] }).success, false)
  assert.equal(normalizeMemoryCall({ target: 'memory', operations: [], action: 'add', content: 'x' }).success, true)
  assert.equal(normalizeMemoryCall({ target: 'memory', operations: [{ action: 'add', content: 'x' }, { action: 'unknown' }] }).success, false)
})

test('patch preserves exact span whitespace and entry metadata', () => {
  const working = [{ text: 'I drink tea daily. Keep this.', seq: 7, createdAt: 'original' }]
  const operation = normalizeMemoryCall({ target: 'memory', operations: [{ action: 'patch', old_text: 'tea ', content: 'coffee ' }] }).operations[0]
  assert.equal(stepOperation(working, operation, 'op1', { next: 8 }), null)
  assert.equal(working[0].text, 'I drink coffee daily. Keep this.')
  assert.equal(working[0].seq, 7)
  assert.equal(working[0].createdAt, 'original')
})

test('whole entry exact match wins over sibling substrings and duplicate exact entries', () => {
  const working = records(['11', 'there are 11 entries', '11'])
  assert.equal(stepOperation(working, { action: 'remove', oldText: '11' }, 'op', { next: 4 }), null)
  assert.deepEqual(working.map(entry => entry.text), ['there are 11 entries', '11'])
})

test('entry location tolerates typography but patch requires exact, unique span', () => {
  assert.equal(normalizeForMatch('“hello” — it\'s\n here'), '"hello" - it\'s here')
  const working = records(['“Tea” — daily\n at noon', 'unrelated'])
  assert.equal(stepOperation(working, { action: 'remove', oldText: '"Tea" - daily at noon' }, 'op', { next: 3 }), null)
  assert.deepEqual(working.map(entry => entry.text), ['unrelated'])
  const patch = records(['“Tea” — daily'])
  assert.match(stepOperation(patch, { action: 'patch', oldText: '"Tea"', content: 'Coffee' }, 'op', { next: 2 }), /exact stored span/)
  assert.equal(patch[0].text, '“Tea” — daily')
  assert.match(stepOperation(records(['1000']), { action: 'patch', oldText: '00', content: '1' }, 'op', { next: 2 }), /more than once/)
})

test('pinned destructive writes refuse changed entries', () => {
  const working = records(['User uses Linux now'])
  assert.match(stepOperation(working, { action: 'remove', oldText: 'User uses', matched_entry: 'User uses Windows' }, 'op', { next: 2 }), /changed since approval/)
  assert.equal(working.length, 1)
  const sibling = records(['User uses', 'User uses Linux'])
  assert.equal(stepOperation(sibling, { action: 'remove', oldText: 'User uses', matched_entry: 'User uses Linux' }, 'op', { next: 3 }), null)
  assert.deepEqual(sibling.map(entry => entry.text), ['User uses'])
})

test('atomic final budget permits add before later remove and includes delimiters', () => {
  const before = records(['1234567890'])
  const working = structuredClone(before)
  const operations = [{ action: 'add', content: '😀😀' }, { action: 'remove', oldText: '1234567890' }]
  for (const operation of operations) assert.equal(stepOperation(working, operation, 'op', { next: 2 }), null)
  assert.equal(validateFinalBatch(before, working, operations, 2), null)
  assert.match(validateFinalBatch([], records(['😀', '中']), [{ action: 'add', content: '😀' }, { action: 'add', content: '中' }], 4), /5\/4 chars/)
})

test('single explicit remove can empty a bank; multiple-operation consolidation cannot', () => {
  assert.equal(validateFinalBatch(['x'], [], [{ action: 'remove', oldText: 'x' }], 1), null)
  assert.match(validateFinalBatch(['x', 'y'], [], [{ action: 'remove', oldText: 'x' }, { action: 'remove', oldText: 'y' }], 50), /empty/)
})

test('remove-only repair and duplicate single add do not deadlock oversized stores', () => {
  const before = ['1234567890', 'stale']
  assert.equal(validateFinalBatch(before, ['1234567890'], [{ action: 'remove', oldText: 'stale' }], 2), null)
  assert.equal(validateFinalBatch(before, before, [{ action: 'add', content: '1234567890' }], 2), null)
  assert.match(validateFinalBatch(before, ['1234567890', 'new'], [{ action: 'patch', oldText: 'stale', content: 'new' }], 2), /chars/)
})

test('prompt module has no imports and pins reviewed upstream', async () => {
  assert.equal(UPSTREAM_COMMIT, 'c0c4357744d1a6994d332b826aea4c77fcccaf38')
  assert.doesNotMatch(await readFile(new URL('../lib/prompts.js', import.meta.url), 'utf8'), /^\s*import\s/m)
  assert.match(MEMORY_GUIDANCE, /EVERY session/)
  assert.match(MEMORY_GUIDANCE, /declarative facts/)
  assert.match(MEMORY_REVIEW_PROMPT, /Never infer/)
  assert.match(MEMORY_REVIEW_PROMPT, /user message or tool result/)
  assert.match(MEMORY_REVIEW_PROMPT, /Nothing to save/)
})

test('schema exposes only operations and available targets using native DSH required flags', () => {
  const schema = createMemoryToolParameters(['user'])
  assert.deepEqual(Object.keys(schema), ['target', 'operations'])
  assert.deepEqual(schema.target.enum, ['user'])
  assert.equal(schema.target.required, true)
  assert.equal(schema.operations.required, true)
  assert.deepEqual(schema.operations.items.properties.action.enum, ['add', 'patch', 'remove'])
  assert.equal(schema.operations.items.properties.action.required, true)
  assert.equal(schema.operations.items.required, undefined)
  assert.equal(schema.operations.items.properties.target, undefined)
  assert.equal(schema.operations.items.additionalProperties, false)
  assert.match(createMemoryToolDescription(['user']), /Only target='user'/)
})

test('real defineTool compiles nested DSL and enforces required action and enabled targets', async () => {
  for (const enabledBanks of [['memory', 'user'], ['memory'], ['user']]) {
    let executions = 0
    const tool = defineTool({
      name: 'memory_contract_test',
      description: createMemoryToolDescription(enabledBanks),
      parameters: createMemoryToolParameters(enabledBanks),
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async args => { executions++; return args },
    })
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['target', 'operations'])
    assert.deepEqual(tool.parameters.properties.target.enum, enabledBanks)
    const operationSchema = tool.parameters.properties.operations.items
    assert.deepEqual(operationSchema.required, ['action'])
    assert.equal(operationSchema.properties.action.required, undefined)
    assert.equal(operationSchema.additionalProperties, false)
    const valid = { target: enabledBanks[0], operations: [{ action: 'add', content: 'fixture only' }] }
    assert.deepEqual(await tool.execute(valid, {}), valid)
    assert.equal(executions, 1)
    for (const invalid of [
      { target: enabledBanks[0], operations: [{ content: 'missing action' }] },
      { target: enabledBanks[0], operations: [{ action: 'replace', content: 'x', old_text: 'y' }] },
      { target: enabledBanks[0], operations: [{ action: 'add', content: 'x', target: enabledBanks[0] }] },
      { target: enabledBanks[0] },
      { operations: [{ action: 'add', content: 'x' }] },
    ]) await assert.rejects(tool.execute(invalid, {}), error => error.code === 'INVALID_ARGS')
    if (enabledBanks.length === 1) {
      const disabled = enabledBanks[0] === 'user' ? 'memory' : 'user'
      await assert.rejects(tool.execute({ ...valid, target: disabled }, {}), error => error.code === 'INVALID_ARGS')
    }
    assert.equal(executions, 1, 'schema rejection must happen before execution')
  }
})
