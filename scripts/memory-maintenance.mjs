#!/usr/bin/env node
/** Offline owner maintenance. Stop all DSH writers first; never pass a live root. */
import { readFile, open, realpath, readdir } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGuardedStorage } from '../lib/guarded-storage.js'
import { compactRuntime, createMemoryExport } from '../lib/maintenance.js'

export async function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv
  const args = Object.create(null)
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--root', '--out', '--before', '--keep'].includes(rest[i]) || rest[i + 1] === undefined || args[rest[i]]) throw new Error('Invalid or repeated argument')
    args[rest[i]] = rest[i + 1]
  }
  if (!['export', 'compact', 'extract-v1'].includes(action)) throw new Error('Usage: memory-maintenance.mjs export|compact --root <absolute storage directory> --out <new backup.json> [--before <ISO date> --keep <count>]; extract-v1 --root <backup.json> --out <new hermes_memory.json>')
  if (!args['--root'] || !args['--out']) throw new Error('--root and --out are required; output files must not already exist')
  const writeNew = async (file, value) => {
    if (process.platform === 'win32' && /[. ]$/.test(basename(file))) throw new Error('Output filename must not end with a dot or space')
    const handle = await open(resolve(file), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync() }
    finally { await handle.close() }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(resolve(file)), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  if (action === 'extract-v1') {
    const backup = JSON.parse(await readFile(resolve(args['--root']), 'utf8'))
    if (backup.format !== 1 || !backup.bookkeeping) throw new Error('Expected a complete Hermes memory export')
    // Rebuild rather than trust an edited derived v1Document slot.
    const verified = createMemoryExport(backup.bookkeeping.memorySnapshot, backup.bookkeeping.runtimeSnapshot)
    const outputRoot = await realpath(dirname(resolve(args['--out'])))
    const recovery = await createGuardedStorage(outputRoot)
    try {
      if ((await readdir(outputRoot)).some(name => name !== '.hermes-memory.lock')) throw new Error('v1 extraction requires a separate empty recovery directory')
      await writeNew(args['--out'], verified.v1Document)
      return { success: true, action, output: resolve(args['--out']), installed: false }
    } finally { await recovery.close() }
  }
  const backend = await createGuardedStorage(args['--root'])
  try {
    const memory = await backend.kv.open({ name: 'hermes_memory', version: 2, compatibleVersions: [1], tables: ['memory', 'user'], hasGlobal: true })
    const runtime = await backend.kv.open({ name: 'hermes_memory_runtime', version: 1, tables: [], hasGlobal: true })
    const memorySnapshot = await memory.loadAll()
    const runtimeSnapshot = await runtime.loadAll()
    const backup = createMemoryExport(memorySnapshot, runtimeSnapshot)
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
    const outputDirectory = await realpath(dirname(resolve(args['--out'])))
    if (fold(outputDirectory) === fold(backend.status().root)
      && ['hermes_memory.json', 'hermes_memory_runtime.json', '.hermes-memory.lock'].includes(fold(basename(args['--out'])))) throw new Error('Export must not overwrite a live storage path')
    let result
    if (action === 'compact') {
      if (!args['--before']) throw new Error('--before is required; no implicit history deletion')
      result = compactRuntime(runtimeSnapshot.global || { format: 1, pending: {}, reviews: {} }, {
        before: args['--before'], maxDetailed: args['--keep'] === undefined ? 100 : Number(args['--keep']),
      })
    }
    await writeNew(args['--out'], backup)
    if (result?.summary.changed) await runtime.setGlobal(result.data)
    return { success: true, action, backup: resolve(args['--out']), ...(result?.summary || {}), installed: false }
  } finally { await backend.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
