/**
 * Schema coerce / argumentGuard smoke (no live upstream).
 * Run: node scripts/test-argument-guard.mjs
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return await nextResolve(specifier + '.ts', context)
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context)
  }
`), { parentURL: import.meta.url })

async function load(rel) {
  return import(pathToFileURL(path.join(root, rel)).href)
}

async function main() {
  const { enforceRequiredToolArguments, coerceValueToSchema } = await load(
    'src/main/proxy/toolCalling/argumentGuard.ts',
  )

  const tools = [
    {
      name: 'todo_write',
      description: 'write todos',
      source: 'mcp',
      parameters: {
        type: 'object',
        required: ['todos'],
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
    },
    {
      name: 'pwsh',
      description: 'run shell',
      source: 'mcp',
      parameters: {
        type: 'object',
        required: ['command', 'description'],
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          timeout: { type: 'number' },
        },
      },
    },
  ]

  // Stringified JSON array → array
  const coerced = enforceRequiredToolArguments(
    'todo_write',
    {
      todos: JSON.stringify([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'pending' },
      ]),
    },
    tools,
  )
  assert.ok(Array.isArray(coerced.todos))
  assert.equal(coerced.todos.length, 2)
  assert.equal(coerced.todos[0].content, 'a')

  // Single object when array expected → wrap
  const wrapped = enforceRequiredToolArguments(
    'todo_write',
    { todos: { content: 'only', status: 'in_progress' } },
    tools,
  )
  assert.ok(Array.isArray(wrapped.todos))
  assert.equal(wrapped.todos[0].content, 'only')

  // description soft-fill from command
  const filled = enforceRequiredToolArguments('pwsh', { command: 'Get-Date' }, tools)
  assert.equal(typeof filled.description, 'string')
  assert.ok(filled.description.includes('Get-Date'))

  // number string
  const num = coerceValueToSchema('42.5', { type: 'number' })
  assert.equal(num, 42.5)
  assert.equal(coerceValueToSchema('true', { type: 'boolean' }), true)

  // Typo `" \"status"` (from real Qwen session) should repair into array
  const typo = enforceRequiredToolArguments(
    'todo_write',
    {
      todos:
        '{"content": "创建项目", " \\"status\\": \\"in_progress\\"}, {\\"content\\": \\"编写脚本\\", \\"status\\": \\"pending\\"}',
    },
    tools,
  )
  // Outer value is already a JS string of near-JSON; simulate session payload:
  const typo2 = enforceRequiredToolArguments(
    'todo_write',
    {
      todos:
        '{"content": "创建项目", " "status": "in_progress"}, {"content": "编写脚本", "status": "pending"}',
    },
    tools,
  )
  assert.ok(Array.isArray(typo2.todos), 'expected repaired array')
  assert.equal(typo2.todos[0].status, 'in_progress')
  void typo

  // Utterly broken non-JSON stays string
  const broken = enforceRequiredToolArguments(
    'todo_write',
    { todos: 'not-json-at-all' },
    tools,
  )
  assert.equal(typeof broken.todos, 'string')

  // Nested {"argument":{...}} wrapper from placeholder prompts
  const writeTools = [
    {
      name: 'write',
      description: 'write file',
      source: 'mcp',
      parameters: {
        type: 'object',
        required: ['file_path', 'content'],
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  ]
  const nested = enforceRequiredToolArguments(
    'write',
    { argument: { file_path: 'D:/tmp/a.txt', content: 'hello-smoke' } },
    writeTools,
  )
  assert.equal(nested.file_path, 'D:/tmp/a.txt')
  assert.equal(nested.content, 'hello-smoke')
  assert.equal(nested.argument, undefined)

  console.log('test-argument-guard: ok')
}

main().catch((err) => {
  console.error('test-argument-guard: FAIL', err)
  process.exit(1)
})
