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
 */
export function getStreamWatchProtocols(preferred: ToolProtocolId): ToolProtocolAdapter[] {
  const primary = getToolProtocol(preferred)
  if (preferred === 'deepseek_dsml') return [primary]
  return [primary, deepseekDsmlProtocol]
}

export { deepseekDsmlProtocol }
