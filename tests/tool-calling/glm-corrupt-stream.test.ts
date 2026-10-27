import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  {
    name: 'pwsh',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['command', 'description'],
    },
    source: 'openai' as const,
  },
]

function plan(): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'glm',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'required',
    allowedToolNames: new Set(['pwsh']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'glm',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: '1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'glm-5.1',
}

/** Exact corrupt markup observed from GLM stream (no tool_calls wrapper, mangled closes). */
const GLM_CORRUPT =
  '<|CHAT2API|invoke name="mmandoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[echo glm-ok]]></<|CHAT2API|parameter name="description"><![CDATA[Run echo command to output glm-ok]]></</</'

/** End-of-stream finalize matching glm adapter (close dangling tags only once). */
function finalizeGlmToolMarkup(text: string): string {
  let out = text
    .replace(/<\/<\|CHAT2API\|/g, '</|CHAT2API|')
    .replace(/<\/<\/+/g, '')
    .replace(/<\/\|CHAT2API\|parameter(?!>)/g, '</|CHAT2API|parameter>')
  const hasInvoke = /<\|CHAT2API\|invoke\b/i.test(out)
  const hasClose = /<\/\|CHAT2API\|invoke>/i.test(out)
  if (hasInvoke && !hasClose && /<\|CHAT2API\|parameter\b/i.test(out)) {
    if (!/<\/\|CHAT2API\|parameter>\s*$/i.test(out) && /<\|CHAT2API\|parameter\b[^>]*>[\s\S]*$/i.test(out)) {
      out += '</|CHAT2API|parameter>'
    }
    out += '</|CHAT2API|invoke>'
  }
  return out
}

test('GLM corrupt stream markup is buffered then parsed or suppressed, never leaked', () => {
  const parser = new ToolStreamParser(plan())
  const mid = parser.push(GLM_CORRUPT, baseChunk)
  for (const chunk of mid) {
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string') {
      assert.equal(content.includes('CHAT2API'), false, `leaked: ${content}`)
    }
  }
  const flushed = parser.flush(baseChunk, finalizeGlmToolMarkup)
  for (const chunk of flushed) {
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string') {
      assert.equal(content.includes('CHAT2API'), false)
    }
  }
  assert.equal(parser.hasEmittedToolCall(), true)
  const toolChunk = flushed.find((c) => c.choices?.[0]?.delta?.tool_calls)
  assert.ok(toolChunk)
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'pwsh')
})

test('mid-stream incomplete invoke is not prematurely closed into empty/truncated args', () => {
  const parser = new ToolStreamParser(plan())
  // Simulate streaming: first chunk has invoke+parameter start but incomplete value.
  const early = parser.push(
    '<|CHAT2API|invoke name="pwsh"><|CHAT2API|parameter name="command">Get-',
    baseChunk,
  )
  assert.equal(parser.hasEmittedToolCall(), false, 'must not emit until close or finalize')
  assert.equal(early.some((c) => c.choices?.[0]?.delta?.tool_calls), false)
  // More content arrives before end.
  parser.push('Date</|CHAT2API|parameter><|CHAT2API|parameter name="description">now</|CHAT2API|parameter>', baseChunk)
  const flushed = parser.flush(baseChunk, finalizeGlmToolMarkup)
  assert.equal(parser.hasEmittedToolCall(), true)
  const argsRaw = flushed
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
    .map((t: any) => t.function?.arguments || '')
    .join('')
  const args = JSON.parse(argsRaw || '{}')
  assert.equal(args.command, 'Get-Date')
  assert.equal(args.description, 'now')
})

test('GLM corrupt markup with recovered close can parse tool call', () => {
  // If we normalize mangled closes, parser should recover.
  const normalized =
    '<|CHAT2API|invoke name="mmandoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[echo glm-ok]]></|CHAT2API|parameter><|CHAT2API|parameter name="description"><![CDATA[Run echo]]></|CHAT2API|parameter></|CHAT2API|invoke>'
  const result = managedXmlProtocol.parse(normalized, { tools, protocol: 'managed_xml' })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'pwsh')
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  assert.equal(args.command, 'echo glm-ok')
})

test('standalone corrupt invoke without wrapper still parses after attribute recovery', () => {
  const content =
    '<|CHAT2API|invoke name="mmandoke name="pwsh"><|CHAT2API|parameter name="command"><![CDATA[echo glm-ok]]></|CHAT2API|parameter><|CHAT2API|parameter name="description"><![CDATA[Run echo]]></|CHAT2API|parameter></|CHAT2API|invoke>'
  const result = managedXmlProtocol.parse(content, { tools, protocol: 'managed_xml' })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'pwsh')
})
