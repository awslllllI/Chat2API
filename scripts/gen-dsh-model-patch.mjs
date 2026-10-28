/**
 * Generate conservative llm-pi-ai model entries for dsh cordis.patch.yml
 */
import fs from 'fs'

const metas = {
  'Kimi-K2.6': { cw: 262144, mt: 32768, input: ['text', 'image'] },
  'deepseek-v4-flash': { cw: 262144, mt: 65536, input: ['text', 'image'] },
  'deepseek-v4-pro': { cw: 262144, mt: 65536, input: ['text'] },
  'GLM-5.1': { cw: 200000, mt: 65536, input: ['text'] },
  'GLM-5-Turbo': { cw: 200000, mt: 65536, input: ['text'] },
  'GLM-5V-Turbo': { cw: 200000, mt: 65536, input: ['text', 'image'] },
  'GLM-5': { cw: 200000, mt: 65536, input: ['text'] },
  'GLM-4.7': { cw: 200000, mt: 65536, input: ['text'] },
  'MiniMax-M2.7': { cw: 204800, mt: 65536, input: ['text'] },
  'Qwen3.6': { cw: 262144, mt: 65536, input: ['text', 'image'] },
  'Qwen3.7-Max': { cw: 262144, mt: 65536, input: ['text'] },
  'Qwen3.5-Flash': { cw: 262144, mt: 65536, input: ['text', 'image'] },
  'Qwen3-Max': { cw: 131072, mt: 32768, input: ['text'] },
  'Qwen3-Max-Thinking-Preview': { cw: 131072, mt: 32768, input: ['text'] },
  'Qwen3-Coder': { cw: 131072, mt: 32768, input: ['text'] },
  'MiMo-V2.5-Pro': { cw: 262144, mt: 65536, input: ['text'] },
  'MiMo-V2.5': { cw: 262144, mt: 65536, input: ['text', 'image'] },
  'MiMo-V2-Flash': { cw: 131072, mt: 32768, input: ['text'] },
  Auto: { cw: 127000, mt: 8192, input: ['text'] },
}

/** Resolve base id for think/search variants. */
function baseOf(id) {
  return id.replace(/-(think-search|think|search)$/i, '')
}

const ids = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'GLM-5.1',
  'GLM-5-Turbo',
  'GLM-5V-Turbo',
  'GLM-5',
  'GLM-4.7',
  'deepseek-v4-flash-think',
  'deepseek-v4-flash-search',
  'deepseek-v4-flash-think-search',
  'deepseek-v4-pro-think',
  'deepseek-v4-pro-search',
  'deepseek-v4-pro-think-search',
  'Qwen3.6',
  'Qwen3.7-Max',
  'Qwen3.5-Flash',
  'Qwen3-Max',
  'Qwen3-Max-Thinking-Preview',
  'Qwen3-Coder',
  'MiMo-V2.5-Pro',
  'MiMo-V2.5',
  'MiMo-V2-Flash',
  'Kimi-K2.6',
  'MiniMax-M2.7',
  'Auto',
]

let out = ''
for (const id of ids) {
  const m = metas[id] || metas[baseOf(id)]
  if (!m) throw new Error(`missing meta for ${id}`)
  const input = m.input.map((x) => `'${x}'`).join(', ')
  out += `          - id: ${id}\n`
  out += `            name: ${id}\n`
  out += `            contextWindow: ${m.cw}\n`
  out += `            maxTokens: ${m.mt}\n`
  out += `            input: [${input}]\n`
}

const outPath = process.argv[2] || 'C:/Users/Administrator/AppData/Local/Temp/dsh-models.yml'
fs.writeFileSync(outPath, out)
console.log(`wrote ${ids.length} models -> ${outPath}`)
