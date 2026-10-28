/**
 * Rewrite desktop cordis.patch.yml chat2api models with conservative meta.
 */
import fs from 'fs'

const patchPath = process.env.DSH_PATCH
  || 'C:/Users/Administrator/.dsh/profiles/desktop/cordis.patch.yml'
const modelsPath = process.env.DSH_MODELS_YML
  || 'C:/Users/Administrator/AppData/Local/Temp/dsh-models.yml'

const text = fs.readFileSync(patchPath, 'utf8')
const models = fs.readFileSync(modelsPath, 'utf8')
const start = text.indexOf('        models:')
if (start < 0) throw new Error('models: not found in patch')

let out = `${text.slice(0, start)}        models:\n${models}`

if (!out.includes('model-meta-autofill')) {
  out += `- insert:
    - id: model-meta-autofill
      name: 'dsh-model-meta-autofill'
      config:
        sources: [models.dev]
        refreshOnStart: true
        autoApply: true
        fillName: true
        fillInput: true
        fillReasoning: false
`
}

if (!out.includes('llm-capabilities') && !out.includes('dsh-llm-capabilities')) {
  out += `- insert:
    - id: llm-capabilities
      name: 'dsh-llm-capabilities'
`
}

fs.writeFileSync(patchPath, out)
console.log(`updated ${patchPath} (${out.length} bytes)`)
