/**
 * Isolated real-adapter smoke. Default is OFFLINE: no model preparation/stream.
 * HERMES_LIVE_REVIEW_SMOKE=1 explicitly enables one inference request by default.
 * HERMES_SMOKE_ITERATIONS=2 allows a save followed by a final model response.
 * No real memory plugin, agents, sessions, or storage units are mounted.
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'
import { runReview } from '../lib/review.js'
import { MEMORY_REVIEW_PROMPT, MEMORY_GUIDANCE, createMemoryToolDescription, createMemoryToolParameters } from '../lib/prompts.js'
import { normalizeMemoryCall, stepOperation, validateFinalBatch } from '../lib/core.js'

const live = process.env.HERMES_LIVE_REVIEW_SMOKE === '1'
if (!process.env.DSH_CLIENT_TEST_CHECKOUT) throw new Error('Set DSH_CLIENT_TEST_CHECKOUT to a built DSH source checkout')
const checkout = resolve(process.env.DSH_CLIENT_TEST_CHECKOUT)
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const profilePath = resolve(process.env.HERMES_SMOKE_PROFILE
  || join(process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', process.env.DSH_PROFILE || 'web'), 'cordis.patch.yml'))
const credentialPath = join(dshHome, '.credentials.yaml')
const maxIterations = Number(process.env.HERMES_SMOKE_ITERATIONS || 1)
if (![1, 2].includes(maxIterations)) throw new Error('HERMES_SMOKE_ITERATIONS must be 1 or 2')

// Import all Cordis participants from the same checkout dependency graph.
const llmRequire = createRequire(join(checkout, 'packages/llm/llm/package.json'))
const loaderRequire = createRequire(join(checkout, 'packages/settings/settings/package.json'))
const yamlRequire = createRequire(join(checkout, 'packages/credentials/credentials-local/package.json'))
const toolRequire = createRequire(new URL('../package.json', import.meta.url))
const { Context } = llmRequire('@deepseek-ai/cordis')
const { default: Loader } = await import(pathToFileURL(loaderRequire.resolve('@deepseek-ai/cordis-plugin-loader')))
const { default: LlmRuntime } = await import(pathToFileURL(join(checkout, 'packages/llm/llm/lib/index.js')))
const LlmPiAi = await import(pathToFileURL(join(checkout, 'packages/llm/llm-pi-ai/lib/index.js')))
const { parseCredentialsDocument, renderFlatLayoutMigration } = await import(pathToFileURL(join(checkout, 'packages/credentials/credentials-local/lib/index.js')))
const { parameterSchemaSpecToJsonSchema } = await import(pathToFileURL(toolRequire.resolve('@deepseek-ai/dsh-tools')))

// Preserve Loader expressions as inert markers. This script never evaluates them.
const patches = yamlRequire('yaml').parse(await readFile(profilePath, 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: expression => ({ __loaderExpression: expression }) }],
})
const findRow = (items, id) => {
  if (!Array.isArray(items)) return undefined
  for (const row of items) {
    if (row?.id === id) return row
    const nested = findRow(row?.insert, id) || (row?.group ? findRow(row?.config, id) : undefined)
    if (nested) return nested
  }
}
const selection = findRow(patches, 'agent-default-model')?.config
const provider = process.env.HERMES_SMOKE_PROVIDER || selection?.provider
const model = process.env.HERMES_SMOKE_MODEL || selection?.model
if (typeof provider !== 'string' || typeof model !== 'string') throw new Error('No plain provider/model selection in the profile patch')
const rawProfile = structuredClone(findRow(patches, 'llm-pi-ai')?.config?.providers?.[provider])
if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) throw new Error('Selected provider is absent from the profile patch')
const containsExpression = value => value && typeof value === 'object'
  && (Object.hasOwn(value, '__loaderExpression') || Object.values(value).some(containsExpression))
if (containsExpression(rawProfile)) throw new Error('Selected provider needs Loader expression evaluation; use the full composition instead')
const ref = rawProfile.apiKeyEnv
if (typeof ref !== 'string') throw new Error('This smoke supports an explicit API key reference; native OAuth requires its own isolated credential setup')

// Pure parsing avoids credentials-local startup's optional legacy file migration.
let document = { refs: new Map() }
try {
  const text = await readFile(credentialPath, 'utf8')
  document = parseCredentialsDocument(renderFlatLayoutMigration(text) ?? text, credentialPath)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const readDotenv = async path => {
  try { return parseEnv(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}
const projectEnvironment = await readDotenv(join(process.cwd(), '.env'))
const userEnvironment = await readDotenv(join(dshHome, '.env'))
const candidates = [
  ['file', document.refs.get(ref)], ['process', process.env[ref]],
  ['project-env', projectEnvironment[ref]], ['user-env', userEnvironment[ref]],
]
const credential = candidates.find(([, value]) => typeof value === 'string' && value.length > 0)
if (!credential) throw new Error('Selected route credential is not configured')
const [credentialSource, secret] = credential

const ctx = new Context()
// Only one reference is exposed. No credential writes, OAuth refresh, or other keys.
const readonly = async () => { throw new Error('Smoke credentials are read-only') }
ctx.provide('credentials', {
  resolve: async name => name === ref ? { value: secret, source: credentialSource } : undefined,
  describe: async name => ({ configured: name === ref, writable: false }),
  readRecord: async () => undefined,
  listRecords: async () => [],
  describeRecord: async () => ({ configured: false, writable: false }),
  set: readonly, unset: readonly, modifyRecord: readonly, deleteRecord: readonly,
})
// Disallow SDK-internal retries as well as extra loop iterations in the default smoke.
rawProfile.retryPolicy = { mode: 'normal', maxRetries: 0 }
const controller = new AbortController()
let stopTimeout
try {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  ctx.loader.builtins['smoke-pi'] = LlmPiAi
  const id = await ctx.loader.create({ id: 'smoke-pi', name: 'cordis:smoke-pi', config: { providers: { [provider]: rawProfile } } })
  await ctx.loader.resolve(id).fiber.await()
  if (!ctx.llm.listProviders().some(route => route.id === provider)) throw new Error('Selected provider failed to register')

  if (!live) {
    console.log(JSON.stringify({ mode: 'offline', mounted: true, provider, model, credentialConfigured: true, credentialSource,
      liveSwitch: 'HERMES_LIVE_REVIEW_SMOKE=1', maxIterations }))
  } else {
    const outDir = await mkdtemp(join(tmpdir(), 'hermes-real-review-'))
    const storePath = join(outDir, 'memory.json')
    const resultPath = join(outDir, 'result.json')
    let banks = { memory: [], user: [] }
    await writeFile(storePath, JSON.stringify(banks), { mode: 0o600 })
    stopTimeout = setTimeout(() => controller.abort(new Error('Isolated review smoke timed out')), 120000)
    const result = await runReview({
      llm: ctx.llm,
      config: { provider, model, maxTokens: 2048 },
      // RequestUserInput deliberately carries no durable message id or source.
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic fixture user: Remember for all future sessions that I prefer concise answers. This is synthetic test data, not a statement about the real user.' }] }],
      system: MEMORY_REVIEW_PROMPT + '\n\n' + MEMORY_GUIDANCE
        + '\n\nThis is an isolated synthetic fixture. Tools write only to a temporary fixture. Review the synthetic user as the user of this fixture. Its user store is currently empty.',
      tools: [
        { name: 'memory', description: createMemoryToolDescription(), parameters: parameterSchemaSpecToJsonSchema(createMemoryToolParameters()) },
        { name: 'memory_list', description: 'Read the isolated fixture memory.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ],
      readMemory: async () => ({ success: true, ...banks }),
      executeMemory: async (args, { signal }) => {
        if (signal?.aborted) throw new Error('Fixture write cancelled')
        const call = normalizeMemoryCall(args)
        if (!call.success) return call
        const before = banks[call.target], working = structuredClone(before)
        const seq = { next: Math.max(0, ...before.map(entry => entry.seq)) + 1 }
        for (const op of call.operations) {
          const failure = stepOperation(working, op, op.action, seq)
          if (failure) return { success: false, error: failure }
        }
        const failure = validateFinalBatch(before, working, call.operations, call.target === 'user' ? 1375 : 2200)
        if (failure) return { success: false, error: failure }
        const next = { ...banks, [call.target]: working }
        await writeFile(storePath, JSON.stringify(next, null, 2), { mode: 0o600 })
        banks = next
        return { success: true, done: true, target: call.target, entryCount: working.length }
      },
      signal: controller.signal,
      maxIterations,
    })
    // Raw adapter error strings may include endpoint details. Persist/print only a code.
    const safeResult = { ...result, error: result.error ? { code: result.error.code || 'REVIEW_ERROR' } : undefined, provider, model }
    await writeFile(resultPath, JSON.stringify(safeResult, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ mode: 'live', provider, model, status: result.status, iterations: result.iterations,
      writes: result.writes, pending: result.pending, toolCalls: result.toolCalls, usage: result.usage,
      errorCode: result.error?.code, outDir }))
    if (result.status === 'error' || result.status === 'aborted' || result.writes < 1) process.exitCode = 1
  }
} catch (error) {
  // Never inspect raw config, credentials, adapter objects, or untrusted error text.
  console.error(JSON.stringify({ mode: live ? 'live' : 'offline', status: 'failed', code: String(error?.code || error?.name || 'SMOKE_ERROR') }))
  process.exitCode = 1
} finally {
  if (stopTimeout) clearTimeout(stopTimeout)
  controller.abort(new Error('Smoke finished'))
  await ctx.fiber.dispose()
}
