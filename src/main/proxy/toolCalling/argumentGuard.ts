/**
 * Enforce / soft-fill required tool arguments after parsing text protocols.
 */

import type { NormalizedToolDefinition } from './types.ts'

/**
 * Ensure required JSON-schema properties exist when possible.
 * - Missing `description` with a `command` → synthesize a short description
 * - Other missing required string fields stay missing (caller may still fail client-side)
 */
export function enforceRequiredToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  tools: NormalizedToolDefinition[],
): Record<string, unknown> {
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) return { ...args }

  const next = { ...args }
  const schema = tool.parameters || {}
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required: string[] }).required)
    : []

  for (const key of required) {
    if (next[key] !== undefined && next[key] !== null && next[key] !== '') continue

    if (key === 'description' && typeof next.command === 'string' && next.command.trim()) {
      next.description = summarizeCommand(String(next.command))
      continue
    }
  }

  return next
}

/**
 * Build a short active-voice description from a shell command (≤ ~10 words).
 */
function summarizeCommand(command: string): string {
  const firstLine = command.split(/\r?\n/)[0].trim()
  const clipped = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
  if (!clipped) return 'Run command'
  return `Run: ${clipped}`
}

/**
 * List required argument names for prompt rendering.
 */
export function formatRequiredArgsHint(tool: NormalizedToolDefinition): string {
  const schema = tool.parameters || {}
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required: string[] }).required)
    : []
  if (required.length === 0) return ''
  return ` REQUIRED: [${required.join(', ')}]`
}
