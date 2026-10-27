/**
 * Strip model control / special tokens that should never reach clients as chat text.
 * Do NOT strip complete DSML/Chat2API tool blocks here — parsers need those first.
 */

const CONTROL_TOKEN_PATTERNS: RegExp[] = [
  /<｜end of sentence｜>/g,
  /<\/?｜end of sentence｜>/g,
  /｜end of sentence｜>?/g,
  /<\|end▁of▁sentence\|>/g,
  /<\/?\|end_of_sentence\|>/g,
  /<\|ATls?>?/gi,
  /<\/?\|ATls?>?/gi,
  // Incomplete / truncated Chat2API marker leaks (seen on Qwen: "2API|tool_calls>", "CHAT2API|tool_calls>")
  /<\/?\|CHAT2API\|[^<\n]*/gi,
  /(?<!<)\|CHAT2API\|(?:invoke|tool_calls|parameter|tool_result)[^<\n]*/gi,
  /(?<!\|)CHAT2API\|(?:tool_calls|invoke|parameter|tool_result)[^<\n]*/gi,
  // Truncated markers: "2API|parameter name=...<![CDATA[...]]></"
  /\b2?API\|(?:tool_calls|invoke|parameter|tool_result)[^<\n]*(?:<!\[CDATA\[[\s\S]*?\]\]>)?(?:<\/)?/gi,
  /<!\[CDATA\[[\s\S]*?\]\]>/g,
  /\]\]><\/?/g,
]

/** Leftover DSML crumbs after a successful parse (or failed incomplete emit). */
const DSML_CRUMB_PATTERNS: RegExp[] = [
  /<\/?\s*｜｜DSML｜｜[^>]*>/g,
  /<\/?\s*｜DSML｜[^>]*>/g,
  /<\/?\s*\|DSML\|[^>]*>/g,
]

/**
 * Remove DeepSeek end-of-sentence tokens and broken Chat2API markup fragments.
 */
export function stripModelControlTokens(text: string): string {
  if (!text) return text
  let out = text
  for (const pattern of CONTROL_TOKEN_PATTERNS) {
    out = out.replace(pattern, '')
  }
  return out.replace(/\n{3,}/g, '\n\n')
}

/**
 * Strip residual DSML tags after tool blocks have been consumed by a parser.
 * Does not trim edges so stream deltas can keep intentional whitespace.
 */
export function stripDsmlCrumbs(text: string): string {
  if (!text) return text
  let out = text
  for (const pattern of DSML_CRUMB_PATTERNS) {
    out = out.replace(pattern, '')
  }
  // GLM occasionally leaves broken close crumbs.
  out = out.replace(/<\/<\|CHAT2API\|[^>]*>/g, '')
  out = out.replace(/<\/<\/+/g, '')
  out = out.replace(/(?<!\|)CHAT2API\|(?:tool_calls|invoke|parameter|tool_result)[^<\n]*/gi, '')
  out = out.replace(/\b2?API\|(?:tool_calls|invoke|parameter|tool_result)[^<\n]*/gi, '')
  return out.replace(/\n{3,}/g, '\n\n')
}

/**
 * Full client-facing cleanup for assistant text that is not a tool call.
 * @param trimEdges - When false, preserve leading/trailing whitespace (stream deltas).
 */
export function sanitizeAssistantText(text: string, trimEdges: boolean = true): string {
  const cleaned = stripDsmlCrumbs(stripModelControlTokens(text))
  return trimEdges ? cleaned.trim() : cleaned
}

/**
 * True if buffer looks like the start of a tool protocol (including broken CHAT2API / DSML).
 */
export function looksLikeToolProtocolPrefix(buffer: string): boolean {
  const s = buffer.trimStart()
  if (!s) return false
  return (
    s.startsWith('<|CHAT2API|') ||
    s.startsWith('|CHAT2API|') ||
    s.startsWith('CHAT2API|') ||
    s.startsWith('2API|tool_calls') ||
    s.startsWith('<tool_calls>') ||
    s.startsWith('<｜｜DSML｜｜') ||
    s.startsWith('<｜DSML｜') ||
    s.startsWith('<|DSML|') ||
    s.startsWith('｜｜DSML｜｜') ||
    s.startsWith('<invoke')
  )
}
