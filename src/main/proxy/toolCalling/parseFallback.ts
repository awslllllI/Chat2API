/**
 * Try preferred protocol first, then DeepSeek DSML as a silent fallback parser.
 * Does not cross-parse bracket when XML is selected (preserves protocol selection tests).
 */

import type { ToolCallingPlan, ToolParseResult } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { deepseekDsmlProtocol } from './protocols/deepseekDsml.ts'
import { sanitizeAssistantText } from './textCleanup.ts'
import { enforceRequiredToolArguments } from './argumentGuard.ts'

/**
 * Parse assistant content for tool calls with DSML fallback.
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

  // Only fall back to DSML when preferred protocol found nothing usable.
  if (plan.protocol !== 'deepseek_dsml') {
    const dsml = deepseekDsmlProtocol.parse(content, { ...context, protocol: 'deepseek_dsml' })
    if (dsml.toolCalls.length > 0) {
      return decorateToolCalls(dsml, plan)
    }
    if (dsml.rawMatches.length > 0 || dsml.invalidToolNames.length > 0) {
      return {
        ...dsml,
        content: sanitizeAssistantText(dsml.content || content),
      }
    }
  }

  return {
    ...preferred,
    content: sanitizeAssistantText(preferred.content || content),
  }
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
