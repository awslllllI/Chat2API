/**
 * Try preferred protocol first, then silent fallbacks (DSML / bracket / XML).
 * Models often mix formats when prompts historically taught [function_calls]
 * while the runtime prefers Chat2API XML (especially GLM).
 */

import type { ToolCallingPlan, ToolParseResult, ToolProtocolId } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { deepseekDsmlProtocol } from './protocols/deepseekDsml.ts'
import { managedBracketProtocol } from './protocols/managedBracket.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'
import { sanitizeAssistantText } from './textCleanup.ts'
import { enforceRequiredToolArguments } from './argumentGuard.ts'
import type { ToolProtocolAdapter } from './protocols/base.ts'

/**
 * Parse assistant content for tool calls with multi-protocol fallback.
 */
export function parseToolContentWithFallback(
  content: string,
  plan: ToolCallingPlan,
): ToolParseResult {
  const context = { tools: plan.tools, protocol: plan.protocol }
  const preferred = getToolProtocol(plan.protocol).parse(content, context)
  if (preferred.toolCalls.length > 0) {
    return decorateToolCalls(preferred, plan)
  }

  for (const protocol of fallbackProtocols(plan.protocol)) {
    const parsed = protocol.parse(content, { ...context, protocol: protocol.id })
    if (parsed.toolCalls.length > 0) {
      return decorateToolCalls(parsed, plan)
    }
    if (parsed.rawMatches.length > 0 || parsed.invalidToolNames.length > 0) {
      return {
        ...parsed,
        content: sanitizeAssistantText(parsed.content || content),
      }
    }
  }

  return {
    ...preferred,
    content: sanitizeAssistantText(preferred.content || content),
  }
}

/**
 * Fallback order after preferred protocol fails to produce tool calls.
 */
function fallbackProtocols(preferred: ToolProtocolId): ToolProtocolAdapter[] {
  const all: ToolProtocolAdapter[] = [
    deepseekDsmlProtocol,
    managedXmlProtocol,
    managedBracketProtocol,
  ]
  return all.filter((protocol) => protocol.id !== preferred)
}

/**
 * Re-index tool calls and soft-fill required arguments.
 */
function decorateToolCalls(result: ToolParseResult, plan: ToolCallingPlan): ToolParseResult {
  const toolCalls = result.toolCalls.map((call, index) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      args = {}
    }
    const guarded = enforceRequiredToolArguments(call.function.name, args, plan.tools)
    // Strip internal rawText so OpenAI clients never see protocol markup.
    const { rawText: _rawText, ...openAiCall } = call as typeof call & { rawText?: string }
    void _rawText
    return {
      ...openAiCall,
      index,
      function: {
        ...openAiCall.function,
        arguments: JSON.stringify(guarded),
      },
    }
  })

  return {
    ...result,
    content: sanitizeAssistantText(result.content),
    toolCalls,
  }
}
