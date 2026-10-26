/**
 * Classify upstream failures for cooling / pause decisions.
 * Avoid mapping ambiguous errors to auth (401) so accounts are not wrongly invalidated.
 */

export type UpstreamErrorKind =
  | 'rate_limit'
  | 'ban_or_mute'
  | 'challenge'
  | 'auth'
  | 'empty_success'
  | 'other'

export interface UpstreamErrorClassification {
  kind: UpstreamErrorKind
  /** Human-readable reason for UI/logs (no secrets) */
  reason: string
  /** Suggested cooling duration in ms when kind is rate_limit */
  coolDownMs?: number
}

const BAN_PATTERNS: RegExp[] = [
  /禁言/,
  /被限制/,
  /账号.*限制/,
  /account.*(banned|restricted|suspended|muted)/i,
  /you have been (banned|muted|restricted)/i,
  /临时封禁/,
  /封禁/,
  /mute/i,
]

const RATE_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /请求过于频繁/,
  /访问频率/,
  /稍后重试/,
  /try again later/i,
  /quota/i,
  /429/,
]

const CHALLENGE_PATTERNS: RegExp[] = [
  /captcha/i,
  /验证码/,
  /challenge/i,
  /人机验证/,
  /刷新页面以更新应用/,
  /cf-browser/i,
]

const AUTH_PATTERNS: RegExp[] = [
  /unauthorized/i,
  /invalid.?token/i,
  /token.*(expired|invalid|失效)/i,
  /登录.*过期/,
  /请重新登录/,
  /authentication/i,
]

/**
 * Classify an upstream error from HTTP status and message body.
 */
export function classifyUpstreamError(
  status: number | undefined,
  message: string | undefined,
  options?: { emptyContent?: boolean }
): UpstreamErrorClassification {
  const text = (message || '').trim()

  if (options?.emptyContent) {
    return {
      kind: 'empty_success',
      reason: 'Upstream returned empty assistant content',
    }
  }

  // Prefer explicit HTTP signals before fuzzy text (avoid false auth)
  if (status === 429) {
    return {
      kind: 'rate_limit',
      reason: 'HTTP 429 Too Many Requests',
      coolDownMs: 60_000,
    }
  }

  if (status === 401 || status === 403) {
    // 403 may be ban or auth — check ban patterns first
    if (matchesAny(text, BAN_PATTERNS)) {
      return { kind: 'ban_or_mute', reason: truncate(text) || 'Account restricted (403)' }
    }
    if (status === 401 || matchesAny(text, AUTH_PATTERNS)) {
      return { kind: 'auth', reason: truncate(text) || `HTTP ${status}` }
    }
    // Ambiguous 403 → rate/cool, not auth
    return {
      kind: 'rate_limit',
      reason: truncate(text) || 'HTTP 403 (treated as rate/restriction)',
      coolDownMs: 120_000,
    }
  }

  if (matchesAny(text, BAN_PATTERNS)) {
    return { kind: 'ban_or_mute', reason: truncate(text) || 'Ban/mute detected' }
  }

  if (matchesAny(text, CHALLENGE_PATTERNS)) {
    return { kind: 'challenge', reason: truncate(text) || 'Challenge/captcha detected' }
  }

  if (matchesAny(text, RATE_PATTERNS)) {
    return {
      kind: 'rate_limit',
      reason: truncate(text) || 'Rate limit detected',
      coolDownMs: 60_000,
    }
  }

  // Do not treat generic 5xx/text as auth
  if (matchesAny(text, AUTH_PATTERNS) && status !== undefined && status >= 400 && status < 500) {
    return { kind: 'auth', reason: truncate(text) || 'Auth failure' }
  }

  return {
    kind: 'other',
    reason: truncate(text) || (status ? `HTTP ${status}` : 'Unknown upstream error'),
  }
}

/**
 * Detect empty assistant content in an OpenAI-style non-stream body.
 */
export function isEmptyAssistantContent(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  const message = choices[0]?.message
  if (!message || typeof message !== 'object') return false
  const content = (message as { content?: unknown }).content
  const reasoning = (message as { reasoning_content?: unknown }).reasoning_content
  const hasToolCalls = Array.isArray((message as { tool_calls?: unknown }).tool_calls)
    && ((message as { tool_calls: unknown[] }).tool_calls).length > 0
  if (hasToolCalls) return false
  const contentEmpty = content === undefined || content === null || content === ''
  const reasoningEmpty = reasoning === undefined || reasoning === null || reasoning === ''
  return contentEmpty && reasoningEmpty
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  if (!text) return false
  return patterns.some((p) => p.test(text))
}

function truncate(text: string, max = 160): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
