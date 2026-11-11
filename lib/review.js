/**
 * An isolated auxiliary model loop. Scheduling, transcript policy, approval,
 * deadlines and storage ownership belong to the caller. Keep this file free of
 * imports so the dynamic Host build can embed the same implementation.
 */

const REVIEW_READ_TOOLS = new Set(['memory_list', 'memory_search', 'memory_stats'])
let reviewSequence = 0

function reviewError(message, code = 'REVIEW_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function reviewFailure(error) {
  return {
    message: String(error?.message ?? error ?? 'Background memory review failed'),
    code: String(error?.code ?? 'REVIEW_ERROR'),
  }
}

function reviewAbort(signal) {
  if (!signal?.aborted) return
  throw signal.reason ?? reviewError('Background memory review cancelled', 'ABORTED')
}

/** Race only cancellable preparation/stream reads, never a committed store write. */
function reviewAwait(value, signal) {
  if (!signal) return Promise.resolve(value)
  if (signal.aborted) {
    // The operation can already have started; consume a late rejection.
    Promise.resolve(value).catch(() => {})
    return Promise.reject(signal.reason ?? reviewError('Background memory review cancelled', 'ABORTED'))
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? reviewError('Background memory review cancelled', 'ABORTED')) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

function reviewCopy(value) {
  // Messages, call config and tools use the lossless-JSON DSH wire vocabulary.
  return JSON.parse(JSON.stringify(value))
}

function reviewToolResult(value, failed = false) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return { content: reviewCopy(value.content), isError: failed || value.isError === true || value.success === false }
  }
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value) }
  catch { text = String(value) }
  return {
    content: [{ type: 'text', text: text ?? 'null' }],
    isError: failed || value?.isError === true || value?.success === false,
  }
}

/**
 * Assemble only the DSH stream vocabulary. block-end is authoritative, deltas
 * after a closed block are ignored, and first-seen order is preserved.
 */
async function collectReviewResponse(stream, signal) {
  const partials = new Map()
  let finish, replayState, usage
  const ensure = (index, type) => {
    if (!Number.isSafeInteger(index) || index < 0) throw reviewError('Invalid model block index', 'INVALID_REVIEW_STREAM')
    if (!partials.has(index)) partials.set(index, { type, text: '', arguments: '' })
    return partials.get(index)
  }
  const iterator = stream[Symbol.asyncIterator]()
  let ended = false
  try {
    while (true) {
      reviewAbort(signal)
      const next = await reviewAwait(iterator.next(), signal)
      if (next.done) { ended = true; break }
      reviewAbort(signal)
      const chunk = next.value
      switch (chunk?.type) {
        case 'block-start':
          ensure(chunk.index, chunk.blockType)
          break
        case 'text-delta':
        case 'reasoning-delta': {
          const partial = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
          if (!partial.block) partial.text += chunk.text
          break
        }
        case 'tool-call-delta': {
          const partial = ensure(chunk.index, 'tool-call')
          if (!partial.block) {
            partial.id = chunk.id
            if (chunk.name) partial.name = chunk.name
            partial.arguments += chunk.argumentsDelta
          }
          break
        }
        case 'block-end': {
          const partial = ensure(chunk.index, chunk.block.type)
          if (!partial.block) partial.block = reviewCopy(chunk.block)
          break
        }
        case 'usage':
          usage = reviewCopy(chunk.usage)
          break
        case 'finish':
          finish = chunk.reason
          replayState = chunk.replayState
          ended = true
          break
        default:
          throw reviewError('Unknown model stream chunk', 'INVALID_REVIEW_STREAM')
      }
      if (finish) break
    }
  } finally {
    // Drain a normally finished stream before executing tools. A cancelled
    // adapter may still have a pending next(); close it without blocking unload.
    if (!ended || finish) {
      if (signal?.aborted) {
        try { Promise.resolve(iterator.return?.()).catch(() => {}) } catch {}
      } else {
        await reviewAwait(iterator.return?.(), signal)
      }
    }
  }
  reviewAbort(signal)
  if (!finish) throw reviewError('Model stream ended without a terminal finish', 'INCOMPLETE_REVIEW_STREAM')
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = reviewError(finish.failure?.message ?? `Model request ${finish.kind}`, finish.failure?.code ?? 'REVIEW_MODEL_ERROR')
    error.aborted = finish.kind === 'aborted'
    throw error
  }
  if (!['stop', 'tool-calls', 'max-tokens'].includes(finish.kind)) {
    throw reviewError(`Unsupported model finish: ${finish.kind}`, 'INVALID_REVIEW_STREAM')
  }
  const blocks = [...partials.values()].map(partial => {
    if (partial.block) return partial.block
    if (partial.type === 'text' || partial.type === 'reasoning') return { type: partial.type, text: partial.text }
    if (partial.type === 'tool-call') return { type: 'tool-call', id: partial.id, name: partial.name, arguments: partial.arguments }
    throw reviewError(`Incomplete model block: ${partial.type}`, 'INVALID_REVIEW_STREAM')
  })
  // A mismatched per-block envelope cannot safely replay this assembled answer.
  if (replayState?.blocks !== undefined && replayState.blocks.length !== blocks.length) replayState = undefined
  return { blocks, finish, replayState, usage }
}

/**
 * Run a bounded review using only explicitly supplied memory callbacks.
 *
 * @param {object} options
 * @param {{prepareCall: Function}} options.llm - The official ctx.llm service.
 * @param {object} options.config - Captured request/header.config (including route and controls).
 * @param {object[]} options.messages - Caller-owned, already prepared review evidence. Never truncated here.
 * @param {string} [options.system] - Review-only instructions assembled by the caller.
 * @param {object[]} [options.tools] - Only memory / memory_list / memory_search / memory_stats schemas.
 * @param {Function} [options.executeMemory] - (args, {signal, background:true, toolName}) => saved/pending/error result.
 * @param {Function} [options.readMemory] - (args, {signal, background:true, toolName}) => read-only result.
 * @param {AbortSignal} [options.signal] - Caller combines deadline, unload and lifecycle cancellation.
 * @param {number} [options.maxIterations=16] - Model requests, strictly bounded to at most 16.
 * @param {number} [options.maxInputChars] - Optional reject-only JSON input size cap; no silent truncation.
 * @param {string} [options.sessionId] - Parent identity for auxiliary LLM routing, not a session to append to.
 * @param {Function} [options.idFactory] - Optional generator for temporary message identities.
 * @returns {Promise<object>} Explicit outcome and counters; never appends to a Session or invokes registry tools.
 */
export async function runReview(options = {}) {
  const result = { status: 'error', iterations: 0, writes: 0, pending: 0, toolCalls: 0, text: '', truncated: false }
  const signal = options.signal
  try {
    reviewAbort(signal)
    if (typeof options.llm?.prepareCall !== 'function') throw reviewError('llm.prepareCall is required', 'INVALID_REVIEW_OPTIONS')
    if (!options.config?.provider || !options.config?.model) throw reviewError('Captured provider and model are required', 'INVALID_REVIEW_OPTIONS')
    if (!Array.isArray(options.messages)) throw reviewError('Review messages must be an array', 'INVALID_REVIEW_OPTIONS')
    const limit = options.maxIterations ?? 16
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw reviewError('maxIterations must be an integer from 1 to 16', 'INVALID_REVIEW_OPTIONS')
    if (options.maxInputChars !== undefined && (!Number.isSafeInteger(options.maxInputChars) || options.maxInputChars < 1)) {
      throw reviewError('maxInputChars must be a positive safe integer', 'INVALID_REVIEW_OPTIONS')
    }
    const config = reviewCopy(options.config)
    const messages = reviewCopy(options.messages)
    const tools = reviewCopy(options.tools ?? [])
    const allowed = new Set()
    for (const tool of tools) {
      if (!tool || (tool.name !== 'memory' && !REVIEW_READ_TOOLS.has(tool.name)) || allowed.has(tool.name)) {
        throw reviewError(`Unsupported or duplicate review tool: ${tool?.name}`, 'INVALID_REVIEW_TOOL')
      }
      if (typeof (tool.name === 'memory' ? options.executeMemory : options.readMemory) !== 'function') {
        throw reviewError(`Missing callback for review tool: ${tool.name}`, 'INVALID_REVIEW_OPTIONS')
      }
      allowed.add(tool.name)
    }
    const reviewId = ++reviewSequence
    let messageSequence = 0
    const makeId = () => options.idFactory ? options.idFactory() : `hermes-review-${reviewId}-${++messageSequence}`
    const seenCalls = new Set()
    for (let iteration = 0; iteration < limit; iteration++) {
      reviewAbort(signal)
      const input = { messages, tools, ...(options.system === undefined ? {} : { system: options.system }) }
      if (options.maxInputChars !== undefined && JSON.stringify(input).length > options.maxInputChars) {
        throw reviewError('Review input exceeds maxInputChars; no evidence was truncated', 'REVIEW_INPUT_TOO_LARGE')
      }
      const prepared = await reviewAwait(options.llm.prepareCall(reviewCopy(config), signal), signal)
      reviewAbort(signal)
      result.iterations++
      const response = await collectReviewResponse(prepared.stream({
        ...prepared.config,
        messages: reviewCopy(messages),
        tools: reviewCopy(tools),
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        purpose: 'hermes-memory-review',
        signal,
      }), signal)
      if (response.usage) {
        result.usage ??= {}
        for (const [key, value] of Object.entries(response.usage)) {
          if (typeof value === 'number' && Number.isFinite(value)) result.usage[key] = (result.usage[key] ?? 0) + value
        }
      }
      result.text = response.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      if (response.finish.kind === 'max-tokens') {
        result.error = { message: 'Review response reached the model output limit; no calls from the truncated response were executed', code: 'REVIEW_MAX_TOKENS' }
        return result
      }
      const calls = response.blocks.filter(block => block.type === 'tool-call')
      if (!calls.length) {
        if (response.finish.kind === 'tool-calls') throw reviewError('Model finished with tool-calls but returned no calls', 'INVALID_REVIEW_STREAM')
        result.status = 'completed'
        return result
      }
      // Validate identity before any operation to prevent duplicate call dispatch.
      for (const call of calls) {
        if (typeof call.id !== 'string' || !call.id || seenCalls.has(call.id)) throw reviewError('Missing or duplicate review call identity', 'INVALID_REVIEW_STREAM')
        seenCalls.add(call.id)
      }
      messages.push({
        id: makeId(), role: 'assistant', content: response.blocks,
        source: { kind: 'model', provider: prepared.config.provider, model: prepared.config.model,
          ...(response.replayState === undefined ? {} : { replayState: reviewCopy(response.replayState) }) },
      })
      for (const call of calls) {
        reviewAbort(signal)
        result.toolCalls++
        let value, failure
        try {
          if (!allowed.has(call.name)) throw reviewError(`Review tool is unavailable: ${call.name}`, 'UNKNOWN_REVIEW_TOOL')
          const args = JSON.parse(call.arguments)
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw reviewError('Review tool arguments must be an object', 'INVALID_REVIEW_ARGUMENTS')
          const context = { signal, background: true, toolName: call.name }
          if (call.name === 'memory') {
            // The shared memory owner validates its current public protocol,
            // including operations batches. Do not mirror that business schema.
            // Await a write even on cancellation: it may already be committing.
            value = await options.executeMemory(args, context)
            if (value?.pending === true) result.pending++
            else if (value?.success === true && value?.isError !== true) result.writes++
          } else {
            value = await reviewAwait(options.readMemory(args, context), signal)
          }
        } catch (error) {
          reviewAbort(signal)
          failure = reviewFailure(error)
          value = { success: false, error: failure.message, code: failure.code }
        }
        reviewAbort(signal)
        messages.push({ id: makeId(), role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id,
          ...reviewToolResult(value, !!failure) })
      }
    }
    result.status = 'max-iterations'
    return result
  } catch (error) {
    result.status = signal?.aborted || error?.aborted ? 'aborted' : 'error'
    result.error = reviewFailure(error)
    return result
  }
}
