/**
 * textCleanup crumb strip smoke.
 * Run: node scripts/test-text-cleanup.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

register(
  'data:text/javascript,' +
    encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return await nextResolve(specifier + '.ts', context) } catch {}
    }
    return nextResolve(specifier, context)
  }
`),
  { parentURL: import.meta.url },
)

const { sanitizeAssistantText } = await import(
  pathToFileURL(path.join(root, 'src/main/proxy/toolCalling/textCleanup.ts')).href
)

assert.equal(sanitizeAssistantText('ok\n\n2API|tool_calls>\nCHAT2API|tool_calls>'), 'ok')
assert.equal(sanitizeAssistantText('hello <|CHAT2API|tool_calls>'), 'hello')
assert.equal(
  sanitizeAssistantText(
    '2API|parameter name="file_path"><![CDATA[D:\\\\tmp\\\\a.txt]]></',
  ),
  '',
)
console.log('test-text-cleanup: ok')
