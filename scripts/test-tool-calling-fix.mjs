/**
 * Offline smoke for DSML / broken Chat2API / required-arg fill.
 * Does not hit upstream APIs.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function load(rel) {
  return import(pathToFileURL(join(root, rel)).href)
}

const { deepseekDsmlProtocol } = await load('src/main/proxy/toolCalling/protocols/deepseekDsml.ts')
const { managedXmlProtocol } = await load('src/main/proxy/toolCalling/protocols/managedXml.ts')
const { parseToolContentWithFallback } = await load('src/main/proxy/toolCalling/parseFallback.ts')
const { sanitizeAssistantText } = await load('src/main/proxy/toolCalling/textCleanup.ts')

const tools = [
  {
    name: 'pwsh',
    description: 'Run shell',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command', 'description'],
    },
    source: 'openai',
  },
]

const plan = {
  mode: 'managed',
  protocol: 'managed_xml',
  clientAdapterId: 'standard-openai-tools',
  providerId: 'deepseek',
  tools,
  shouldInjectPrompt: true,
  shouldParseResponse: true,
  toolChoiceMode: 'auto',
  allowedToolNames: new Set(['pwsh']),
  diagnostics: {
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    toolSource: 'openai',
    mode: 'managed',
    protocol: 'managed_xml',
    toolCount: 1,
    injected: true,
    reason: 'smoke',
  },
}

const dsml = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="true">Get-Location</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
const parsed = parseToolContentWithFallback(dsml, plan)
assert.equal(parsed.toolCalls.length, 1)
assert.ok(JSON.parse(parsed.toolCalls[0].function.arguments).description)

const broken =
  '|CHAT2API|invoke name="pwsh">|CHAT2API|parameter name="command">pwd</|CHAT2API|parameter></|CHAT2API|invoke>'
const brokenParsed = managedXmlProtocol.parse(broken, { tools, protocol: 'managed_xml' })
assert.equal(brokenParsed.toolCalls.length, 1)

const cleaned = sanitizeAssistantText('ok｜end of sentence｜>')
assert.equal(cleaned, 'ok')

const direct = deepseekDsmlProtocol.parse(dsml, { tools, protocol: 'deepseek_dsml' })
assert.equal(direct.toolCalls.length, 1)

console.log('test-tool-calling-fix: ok')
void createRequire
