import test from 'node:test'
import assert from 'node:assert/strict'
import { deepseekDsmlProtocol } from '../../src/main/proxy/toolCalling/protocols/deepseekDsml.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { parseToolContentWithFallback } from '../../src/main/proxy/toolCalling/parseFallback.ts'
import { sanitizeAssistantText } from '../../src/main/proxy/toolCalling/textCleanup.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        working_directory: { type: 'string' },
      },
      required: ['command', 'description'],
    },
    source: 'openai' as const,
  },
  {
    name: 'working_directory',
    description: 'Change cwd',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'openai' as const,
  },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(tools.map((t) => t.name)),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: tools.length,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('DSML protocol parses fullwidth call blocks and fills missing description', () => {
  const content = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ parameter name="command" string="true">Get-Date</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
  const result = deepseekDsmlProtocol.parse(content, { tools, protocol: 'deepseek_dsml' })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'pwsh')
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.command, 'Get-Date')
  assert.ok(typeof args.description === 'string' && args.description.length > 0)
  assert.equal(result.content, '')
})

test('fallback from managed_xml picks up DSML when preferred finds nothing', () => {
  const content = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="working_directory"><｜｜DSML｜｜ parameter name="path" string="true">D:/tmp</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
  const result = parseToolContentWithFallback(content, plan('managed_xml'))

  assert.equal(result.protocol, 'deepseek_dsml')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'working_directory')
})

test('broken CHAT2API without leading angle bracket is parsed and not leaked', () => {
  const content =
    '|CHAT2API|invoke name="pwsh">|CHAT2API|parameter name="command">echo hi</|CHAT2API|parameter></|CHAT2API|invoke>'
  const result = managedXmlProtocol.parse(content, { tools, protocol: 'managed_xml' })

  assert.equal(result.toolCalls.length, 1)
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.command, 'echo hi')
  assert.ok(args.description)
})

test('sanitize strips end-of-sentence and broken fragments', () => {
  const cleaned = sanitizeAssistantText(
    'hello｜end of sentence｜>|CHAT2API|invoke name="x" leftover',
  )
  assert.equal(cleaned.includes('end of sentence'), false)
  assert.equal(cleaned.includes('|CHAT2API|'), false)
  assert.match(cleaned, /hello/)
})

test('stream parser converts DSML to tool_calls and suppresses trailing junk', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const part1 = parser.push('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh">', baseChunk)
  assert.deepEqual(part1, [])
  assert.equal(parser.isBuffering(), true)

  const part2 = parser.push(
    '<｜｜DSML｜｜ parameter name="command" string="true">dir</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>｜end of sentence｜>',
    baseChunk,
  )

  assert.equal(part2.length, 1)
  assert.equal(part2[0].choices[0].delta.tool_calls[0].function.name, 'pwsh')
  const args = JSON.parse(part2[0].choices[0].delta.tool_calls[0].function.arguments)
  assert.ok(args.description)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('stream parser does not emit raw DSML as content when incomplete', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('<｜｜DSML｜｜ calls>', baseChunk)
  const flushed = parser.flush(baseChunk)
  assert.deepEqual(flushed, [])
})

test('standalone Chat2API invoke without tool_calls wrapper is buffered and parsed', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|invoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[Get-Date]]></|CHAT2API|parameter><|CHAT2API|parameter name="description"><![CDATA[now]]></|CHAT2API|parameter></|CHAT2API|invoke>',
    baseChunk,
  )
  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'pwsh')
})

test('malformed Chat2API stream junk is suppressed instead of leaked', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const mid = parser.push(
    '<|ATls><|CHAT2API|invoke name="mmandoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[echo hi]]></',
    baseChunk,
  )
  // May emit sanitized prefix, but must not leave raw CHAT2API in content deltas
  for (const chunk of mid) {
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string') {
      assert.equal(content.includes('CHAT2API'), false)
    }
  }
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('streaming does not emit empty {} before invoke parameters arrive', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const open = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="pwsh">',
    baseChunk,
  )
  assert.deepEqual(open, [])
  assert.equal(parser.isBuffering(), true)
  assert.equal(parser.hasEmittedToolCall(), false)

  const mid = parser.push(
    '<|CHAT2API|parameter name="command"><![CDATA[Get-Date]]></|CHAT2API|parameter>',
    baseChunk,
  )
  assert.deepEqual(mid, [])
  assert.equal(parser.hasEmittedToolCall(), false)

  const done = parser.push(
    '<|CHAT2API|parameter name="description"><![CDATA[show time]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )
  assert.equal(done.length, 1)
  const args = JSON.parse(done[0].choices[0].delta.tool_calls[0].function.arguments)
  assert.equal(args.command, 'Get-Date')
  assert.ok(args.description)
})

test('incomplete standalone invoke is not treated as empty tool call', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|invoke name="pwsh">',
    { tools, protocol: 'managed_xml' },
  )
  assert.equal(result.toolCalls.length, 0)
})

test('corrupted GLM double-name invoke still resolves real tool name and args', () => {
  const content =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="mmandoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[Get-Date]]></|CHAT2API|parameter><|CHAT2API|parameter name="description"><![CDATA[now]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const result = managedXmlProtocol.parse(content, { tools, protocol: 'managed_xml' })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'pwsh')
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.command, 'Get-Date')
})

test('XML plan falls back to bracket function_calls blocks', () => {
  const content =
    '[function_calls]\n[call:pwsh]{"command":"Get-Date","description":"now"}[/call]\n[/function_calls]'
  const result = parseToolContentWithFallback(content, plan('managed_xml'))
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'pwsh')
})
