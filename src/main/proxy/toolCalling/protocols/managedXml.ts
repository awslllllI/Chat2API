import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'
import { enforceRequiredToolArguments } from '../argumentGuard.ts'
import { sanitizeAssistantText } from '../textCleanup.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const CHAT2API_INVOKE = '<|CHAT2API|invoke'
const XML_START = '<tool_calls>'
const XML_INVOKE = '<invoke'

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

When calling tools, respond with ONLY this Chat2API XML block (no prose before/after, no special tokens):

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Rules:
- Include EVERY required argument listed for the tool. Never omit required fields such as description when the schema marks them required.
- Keep the exact angle-bracket form <|CHAT2API|...>. Do not drop the leading "<".
- Do not emit end-of-sentence tokens or other model control markers in the reply.

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
  },

  detectStart(buffer) {
    // Include bare invoke markers: some models skip the tool_calls wrapper (seen on GLM stream).
    // Broken `|CHAT2API|` (no '<') is handled in ToolStreamParser.
    return detectMarkers(buffer, [CHAT2API_START, CHAT2API_INVOKE, XML_START, XML_INVOKE])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    parseBlocks(parseable, {
      blockPattern: /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT2API\|tool_calls>/g,
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
      tools: context.tools,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
      parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
      tools: context.tools,
    })

    // Tolerate broken Chat2API without leading '<' (seen in DeepSeek leaks)
    if (toolCalls.length === 0) {
      parseBlocks(parseable, {
        blockPattern: /(?<!<)\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT2API\|tool_calls>/g,
        invokePattern: /\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
        parameterPattern: /\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolCalls,
        tools: context.tools,
      })
    }

    // Standalone invoke without tool_calls wrapper (well-formed or broken)
    if (toolCalls.length === 0) {
      parseStandaloneInvokes(parseable, {
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolCalls,
        tools: context.tools,
      })
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content: sanitizeAssistantText(content),
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = sanitizeAssistantText(
      rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable),
    )
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|CHAT2API|tool_result>`
  },
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
  tools: ToolParseContext['tools']
}

/**
 * Parse tool_calls wrapper blocks into OpenAI-shaped tool calls.
 */
function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null
    options.invokePattern.lastIndex = 0

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      const name = invokeMatch[1].trim()
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(name)
        continue
      }

      const args: Record<string, unknown> = {}
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      const guarded = enforceRequiredToolArguments(name, args, options.tools)
      options.toolCalls.push(
        buildToolCall(
          `call_${options.toolCalls.length}`,
          options.toolCalls.length,
          name,
          JSON.stringify(guarded),
          invokeMatch[0],
        ),
      )
    }
  }
}

/**
 * Parse standalone invoke blocks without a tool_calls wrapper.
 * Supports well-formed `<|CHAT2API|invoke>` and broken `|CHAT2API|invoke`.
 */
function parseStandaloneInvokes(
  content: string,
  options: Omit<ParseBlockOptions, 'blockPattern' | 'invokePattern' | 'parameterPattern'>,
): void {
  const patterns: Array<{ invoke: RegExp; parameter: RegExp }> = [
    {
      invoke:
        /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/\|CHAT2API\|invoke>|(?=<\|CHAT2API\|invoke)|$)/g,
      parameter:
        /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/\|CHAT2API\|parameter>|(?=<\|CHAT2API\|parameter)|(?=<\|CHAT2API\|invoke)|$)/g,
    },
    {
      invoke:
        /(?<!<)\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/\|CHAT2API\|invoke>|(?=\|CHAT2API\|invoke)|$)/g,
      parameter:
        /\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/\|CHAT2API\|parameter>|(?=\|CHAT2API\|parameter)|(?=\|CHAT2API\|invoke)|$)/g,
    },
    {
      invoke: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/invoke>|(?=<invoke)|$)/g,
      parameter:
        /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter)|(?=<invoke)|$)/g,
    },
  ]

  for (const pattern of patterns) {
    let invokeMatch: RegExpExecArray | null
    while ((invokeMatch = pattern.invoke.exec(content)) !== null) {
      options.rawMatches.push(invokeMatch[0])
      const name = invokeMatch[1].trim()
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(name)
        continue
      }

      const args: Record<string, unknown> = {}
      let parameterMatch: RegExpExecArray | null
      pattern.parameter.lastIndex = 0
      while ((parameterMatch = pattern.parameter.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      const guarded = enforceRequiredToolArguments(name, args, options.tools)
      options.toolCalls.push(
        buildToolCall(
          `call_${options.toolCalls.length}`,
          options.toolCalls.length,
          name,
          JSON.stringify(guarded),
          invokeMatch[0],
        ),
      )
    }
    if (options.toolCalls.length > 0) break
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
