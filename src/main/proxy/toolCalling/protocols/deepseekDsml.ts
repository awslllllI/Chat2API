/**
 * DeepSeek DSML tool-call text protocol parser.
 * Models sometimes emit DSML (special-token style) instead of Chat2API XML.
 * Observed forms use fullwidth bars ｜, e.g.:
 *   <｜｜DSML｜｜ calls> ... <｜｜DSML｜｜ invoke name="pwsh"> ...
 */

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
import { sanitizeAssistantText } from '../textCleanup.ts'
import { enforceRequiredToolArguments } from '../argumentGuard.ts'

/** Fullwidth DSML markers seen in dsh sessions */
const DSML_CALLS_OPEN = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜calls>',
  '<｜DSML｜calls>',
  '<|DSML|calls>',
  '<|DSML| function_calls>',
  '<|DSML|function_calls>',
]

const DSML_CALLS_CLOSE = [
  '</｜｜DSML｜｜ calls>',
  '</｜｜DSML｜｜calls>',
  '</｜DSML｜calls>',
  '</|DSML|calls>',
  '</|DSML| function_calls>',
  '</|DSML|function_calls>',
]

export const deepseekDsmlProtocol: ToolProtocolAdapter = {
  id: 'deepseek_dsml',

  renderPrompt(tools) {
    // Prefer Chat2API XML in prompts; DSML is a fallback parser only.
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.

${renderToolList(tools)}

Prefer Chat2API XML tool blocks. If you use DSML, include every required parameter.`
  },

  detectStart(buffer) {
    const markers = [
      ...DSML_CALLS_OPEN,
      '<｜｜DSML｜｜',
      '<｜DSML｜',
      '<|DSML|',
      '｜｜DSML｜｜',
    ]
    return detectMarkers(buffer, markers)
  },

  parse(content: string, context: ToolParseContext) {
    // Keep DSML tags intact for regex; strip fences only.
    const cleaned = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    // Extract DSML call blocks (open...close) with flexible token spelling
    const blockPattern =
      /<\s*｜?｜?DSML｜?｜?\s*(?:function_)?calls\s*>([\s\S]*?)<\/\s*｜?｜?DSML｜?｜?\s*(?:function_)?calls\s*>|<\s*\|DSML\|\s*(?:function_)?calls\s*>([\s\S]*?)<\/\s*\|DSML\|\s*(?:function_)?calls\s*>/gi

    let blockMatch: RegExpExecArray | null
    while ((blockMatch = blockPattern.exec(cleaned)) !== null) {
      rawMatches.push(blockMatch[0])
      const body = blockMatch[1] ?? blockMatch[2] ?? ''
      parseInvokes(body, {
        allowedNames,
        invalidToolNames,
        toolCalls,
        tools: context.tools,
      })
    }

    // Also accept standalone invoke blocks without outer calls wrapper
    if (toolCalls.length === 0) {
      const invokeOnly = cleaned.match(
        /<\s*｜?｜?DSML｜?｜?\s*invoke\b[\s\S]*?<\/\s*｜?｜?DSML｜?｜?\s*invoke\s*>|<\s*\|DSML\|\s*invoke\b[\s\S]*?<\/\s*\|DSML\|\s*invoke\s*>/gi,
      )
      if (invokeOnly?.length) {
        for (const raw of invokeOnly) {
          rawMatches.push(raw)
          parseInvokes(raw, {
            allowedNames,
            invalidToolNames,
            toolCalls,
            tools: context.tools,
          })
        }
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content: sanitizeAssistantText(cleaned),
        toolCalls,
        protocol: rawMatches.length > 0 ? 'deepseek_dsml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    let remainder = cleaned
    for (const raw of rawMatches) {
      remainder = remainder.replace(raw, '')
    }

    return createParseResult({
      content: sanitizeAssistantText(remainder),
      toolCalls,
      protocol: 'deepseek_dsml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls
      .map((call) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.arguments || '{}')
        } catch {
          args = {}
        }
        const params = Object.entries(args)
          .map(
            ([name, value]) =>
              `<｜｜DSML｜｜ parameter name="${escapeXmlAttribute(name)}" string="true">${
                typeof value === 'string' ? value : JSON.stringify(value)
              }</｜｜DSML｜｜ parameter>`,
          )
          .join('')
        return `<｜｜DSML｜｜ invoke name="${escapeXmlAttribute(call.name)}">${params}</｜｜DSML｜｜ invoke>`
      })
      .join('')
    return `<｜｜DSML｜｜ calls>${invokes}</｜｜DSML｜｜ calls>`
  },

  formatToolResult(result) {
    return `<｜｜DSML｜｜ tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}">${result.content}</｜｜DSML｜｜ tool_result>`
  },
}

function parseInvokes(
  body: string,
  options: {
    allowedNames: Set<string>
    invalidToolNames: string[]
    toolCalls: ReturnType<typeof buildToolCall>[]
    tools: ToolParseContext['tools']
  },
): void {
  const invokePattern =
    /<\s*｜?｜?DSML｜?｜?\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\s*｜?｜?DSML｜?｜?\s*invoke\s*>|<\s*\|DSML\|\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\s*\|DSML\|\s*invoke\s*>/gi

  let invokeMatch: RegExpExecArray | null
  while ((invokeMatch = invokePattern.exec(body)) !== null) {
    const name = (invokeMatch[1] || invokeMatch[3] || '').trim()
    const inner = invokeMatch[2] || invokeMatch[4] || ''
    if (!name) continue
    if (!options.allowedNames.has(name)) {
      options.invalidToolNames.push(name)
      continue
    }

    const args: Record<string, unknown> = {}
    const parameterPattern =
      /<\s*｜?｜?DSML｜?｜?\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\s*｜?｜?DSML｜?｜?\s*parameter\s*>|<\s*\|DSML\|\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\s*\|DSML\|\s*parameter\s*>/gi

    let parameterMatch: RegExpExecArray | null
    while ((parameterMatch = parameterPattern.exec(inner)) !== null) {
      const pname = (parameterMatch[1] || parameterMatch[3] || '').trim()
      const pvalue = parameterMatch[2] ?? parameterMatch[4] ?? ''
      if (!pname) continue
      addParameter(args, pname, parseJsonValue(pvalue))
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
