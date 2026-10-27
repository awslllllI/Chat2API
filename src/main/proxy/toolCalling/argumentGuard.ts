/**
 * Enforce / soft-fill / schema-coerce tool arguments after parsing text protocols.
 */

import type { NormalizedToolDefinition } from './types.ts'

type JsonSchemaNode = {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  required?: string[]
}

/**
 * Ensure required JSON-schema properties exist and coerce obvious type mismatches.
 * - Missing `description` with a `command` → synthesize a short description
 * - string that JSON-parses to array/object/number/boolean when schema asks for that type
 * - single object when schema asks for array → wrap as [object]
 */
export function enforceRequiredToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  tools: NormalizedToolDefinition[],
): Record<string, unknown> {
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) return unwrapArgumentWrapper({ ...args })

  const schema = (tool.parameters || {}) as JsonSchemaNode
  const properties = schema.properties || {}
  const required = Array.isArray(schema.required) ? schema.required : []

  // Models often nest real params under {"argument":{...}} because prompts used that as a placeholder.
  let next: Record<string, unknown> = unwrapArgumentWrapper({ ...args }, properties)

  for (const [key, value] of Object.entries(next)) {
    const propSchema = properties[key]
    if (!propSchema) continue
    next[key] = coerceValueToSchema(value, propSchema)
  }

  for (const key of required) {
    if (next[key] !== undefined && next[key] !== null && next[key] !== '') continue

    if (key === 'description' && typeof next.command === 'string' && next.command.trim()) {
      next.description = summarizeCommand(String(next.command))
    }
  }

  return next
}

/**
 * Flatten mistaken {"argument": { ...real params }} wrappers.
 */
export function unwrapArgumentWrapper(
  args: Record<string, unknown>,
  properties?: Record<string, JsonSchemaNode>,
): Record<string, unknown> {
  const nested = args.argument
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
    return args
  }
  const nestedObj = nested as Record<string, unknown>
  const propKeys = properties ? Object.keys(properties) : []
  const hasSchemaOverlap =
    propKeys.length === 0 ||
    propKeys.some((key) => Object.prototype.hasOwnProperty.call(nestedObj, key))
  const topHasRealProps =
    propKeys.length > 0 &&
    propKeys.some((key) => key !== 'argument' && args[key] !== undefined)

  if (!hasSchemaOverlap || topHasRealProps) {
    return args
  }

  const { argument: _ignored, ...rest } = args
  void _ignored
  return { ...nestedObj, ...rest }
}

/**
 * Coerce a single argument value toward the declared JSON Schema type.
 */
export function coerceValueToSchema(value: unknown, schema: JsonSchemaNode): unknown {
  const expected = primaryType(schema.type)
  if (!expected) return value

  if (expected === 'array') {
    return coerceToArray(value, schema)
  }
  if (expected === 'object') {
    return coerceToObject(value)
  }
  if (expected === 'number' || expected === 'integer') {
    return coerceToNumber(value, expected === 'integer')
  }
  if (expected === 'boolean') {
    return coerceToBoolean(value)
  }
  return value
}

/**
 * Resolve primary schema type from string or union.
 */
function primaryType(type: string | string[] | undefined): string | undefined {
  if (!type) return undefined
  if (Array.isArray(type)) {
    return type.find((t) => t !== 'null') || type[0]
  }
  return type
}

/**
 * Coerce value to array when schema expects array.
 */
function coerceToArray(value: unknown, schema: JsonSchemaNode): unknown {
  if (Array.isArray(value)) {
    return coerceArrayItems(value, schema.items)
  }

  if (value !== null && typeof value === 'object') {
    return coerceArrayItems([value], schema.items)
  }

  if (typeof value !== 'string') return value

  const trimmed = value.trim()
  if (!trimmed) return value

  const repaired = repairLooseJsonString(trimmed)
  const parsed =
    tryParseJson(repaired) ??
    tryParseJson(`[${repaired}]`) ??
    extractObjectArrayFromLooseString(repaired)
  if (parsed === undefined) return value

  if (Array.isArray(parsed)) {
    return coerceArrayItems(parsed, schema.items)
  }
  if (parsed !== null && typeof parsed === 'object') {
    return coerceArrayItems([parsed], schema.items)
  }
  return value
}

/**
 * Fix common model typos before JSON.parse (e.g. `" \"status"` → `"status"`).
 */
function repairLooseJsonString(text: string): string {
  return text
    .replace(/"\s+"status"/g, '"status"')
    .replace(/"\s+"content"/g, '"content"')
    .replace(/,\s*,/g, ',')
}

/**
 * Last-resort: pull {content,status} objects out of a near-JSON blob.
 */
function extractObjectArrayFromLooseString(text: string): unknown[] | undefined {
  const items: Array<Record<string, string>> = []
  const re =
    /\{\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"status"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    items.push({
      content: unescapeJsonString(match[1]),
      status: unescapeJsonString(match[2]),
    })
  }
  return items.length > 0 ? items : undefined
}

/**
 * Unescape a JSON string body fragment.
 */
function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

/**
 * Coerce each array item when items schema is present.
 */
function coerceArrayItems(items: unknown[], itemSchema?: JsonSchemaNode): unknown[] {
  if (!itemSchema) return items
  return items.map((item) => coerceValueToSchema(item, itemSchema))
}

/**
 * Coerce value to object when schema expects object.
 */
function coerceToObject(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  if (typeof value !== 'string') return value
  const parsed = tryParseJson(value.trim())
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed
  }
  return value
}

/**
 * Coerce numeric strings to number/integer.
 */
function coerceToNumber(value: unknown, asInteger: boolean): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return asInteger ? Math.trunc(value) : value
  }
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return value
  return asInteger ? Math.trunc(n) : n
}

/**
 * Coerce boolean-like strings.
 */
function coerceToBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '1') return true
  if (trimmed === 'false' || trimmed === '0') return false
  const parsed = tryParseJson(trimmed)
  return typeof parsed === 'boolean' ? parsed : value
}

/**
 * Try JSON.parse; return undefined on failure.
 */
function tryParseJson(text: string): unknown | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
