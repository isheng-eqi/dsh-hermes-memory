import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parts = []
const normalizeNewlines = source => source.replace(/\r\n/g, '\n')
function withoutImports(source) {
  return source.replace(/^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"]\s*;?\r?\n/gm, '')
}
function withoutExports(source) {
  return source.replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '')
}
for (const file of ['core', 'prompts', 'review', 'scheduler', 'maintenance']) {
  const source = normalizeNewlines(await readFile(resolve(root, 'lib', file + '.js'), 'utf8'))
  if (/^import\s/m.test(source)) throw new Error('Dynamic helper must be import-free: ' + file)
  parts.push('// lib/' + file + '.js\n' + withoutExports(source))
}
let main = normalizeNewlines(await readFile(resolve(root, 'lib/index.js'), 'utf8'))
main = withoutImports(main)
// The sandbox cannot import native filesystem code. Never silently bypass a
// requested storage guard; native storageRoot configuration belongs to static deployments.
main = main.replace("import('./guarded-storage.js')", "Promise.reject(new Error('Guarded storage requires the native static bundle'))")
main = main.replace(/export const Config = Schema\.object\([\s\S]*?^\}\)\s*;?\r?\n/m, '')
if (/\bSchema\./u.test(main)) throw new Error('Unconverted schema in dynamic implementation')
main = main.replace("export const name = 'dsh-hermes-memory'", "const name = 'hermes-memory'")
main = main.replace(/export default \{ name, Config, inject, apply \}\s*;?\s*$/m, '')
main = withoutExports(main)
main = main.replaceAll('ctx.tools.register(defineTool({', 'registerDynamicTool(ctx, defineTool({')
const code = `/** Generated from lib modules by scripts/build-host.mjs. Do not edit this mirror. */\nconst defineTool = harness.defineTool\nconst dynamicTools = new Map()\nfunction registerDynamicTool(ctx, tool) {\n  dynamicTools.set(tool.name, tool)\n  const dispose = harness.registerTool(ctx, tool)\n  return () => { dynamicTools.delete(tool.name); return dispose() }\n}\n${parts.join('\n\n')}\n\n${main}\n\nreturn {\n  inject: [...new Set([...inject.filter(key => key !== 'tools'), 'timer'])],\n  async apply(ctx) {\n    await apply(ctx, {})\n    ctx.effect(() => harness.handle('mem-stats', async () => {\n      const tool = dynamicTools.get('memory_stats')\n      if (!tool) throw new Error('Memory statistics are unavailable')\n      return await tool.execute({}, { signal: { aborted: false } })\n    }))\n  },\n}\n`
const target = resolve(root, 'host.js')
if (process.argv.includes('--check')) {
  const current = normalizeNewlines(await readFile(target, 'utf8'))
  if (current !== code) throw new Error('host.js is stale; run npm run build:host')
  console.log('Dynamic Host matches its source modules.')
} else {
  await writeFile(target, code)
  console.log('Generated host.js from shared source modules.')
}
