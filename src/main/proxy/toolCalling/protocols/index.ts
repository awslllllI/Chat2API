import type { ToolProtocolAdapter } from './base.ts'
import type { ToolProtocolId } from '../types.ts'
import { managedBracketProtocol } from './managedBracket.ts'
import { managedXmlProtocol } from './managedXml.ts'
import { anthropicToolUseProtocol } from './anthropicToolUse.ts'
import { codexResponsesProtocol } from './codexResponses.ts'
import { deepseekDsmlProtocol } from './deepseekDsml.ts'

const protocols: Record<ToolProtocolId, ToolProtocolAdapter> = {
  openai_chat: managedBracketProtocol,
  managed_bracket: managedBracketProtocol,
  managed_xml: managedXmlProtocol,
  anthropic_tool_use: anthropicToolUseProtocol,
  codex_responses: codexResponsesProtocol,
  deepseek_dsml: deepseekDsmlProtocol,
}

/**
 * Resolve a tool protocol adapter by id.
 */
export function getToolProtocol(id: ToolProtocolId): ToolProtocolAdapter {
  return protocols[id]
}

/**
 * Managed protocols exposed for config / diagnostics (prompt protocols).
 * DSML is parser-only fallback and intentionally omitted from this list.
 */
export function getManagedProtocols(): ToolProtocolAdapter[] {
  return [
    managedBracketProtocol,
    managedXmlProtocol,
    anthropicToolUseProtocol,
    codexResponsesProtocol,
  ]
}

/**
 * Protocols whose start markers should be watched during streaming.
 * Prefer primary, then watch DSML + the alternate managed text format.
 */
export function getStreamWatchProtocols(preferred: ToolProtocolId): ToolProtocolAdapter[] {
  const primary = getToolProtocol(preferred)
  if (preferred === 'deepseek_dsml') return [primary]

  const watchers = [primary, deepseekDsmlProtocol]
  if (preferred === 'managed_xml' || preferred === 'openai_chat') {
    watchers.push(managedBracketProtocol)
  } else if (preferred === 'managed_bracket') {
    watchers.push(managedXmlProtocol)
  }
  return watchers
}

export { deepseekDsmlProtocol }
