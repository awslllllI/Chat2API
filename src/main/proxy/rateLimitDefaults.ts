/**
 * Per-provider rate-limit defaults for new accounts / unresolved fields.
 * Intentionally loose to avoid false 401/auth churn, but not so loose that
 * clients hit long stalls and stampede-retry. 0 or explicit unset-after-user
 * clear means unlimited at runtime when stored as 0.
 */

export interface AccountRateLimitDefaults {
  /** Sliding-window requests per minute; 0 = unlimited */
  requestsPerMinute: number
  /** Minimum ms between upstream dispatches; 0 = unlimited */
  minIntervalMs: number
  /** In-flight requests per account; 0 = unlimited */
  maxConcurrency: number
}

/** Fallback when provider has no dedicated profile */
export const GENERIC_WEB_RATE_LIMIT_DEFAULTS: AccountRateLimitDefaults = {
  requestsPerMinute: 30,
  minIntervalMs: 1000,
  maxConcurrency: 1,
}

/**
 * Provider-tuned defaults. DeepSeek is stricter (community ban reports);
 * still kept moderate so Agent tool loops remain usable.
 */
export const PROVIDER_RATE_LIMIT_DEFAULTS: Record<string, AccountRateLimitDefaults> = {
  deepseek: {
    requestsPerMinute: 24,
    minIntervalMs: 1500,
    maxConcurrency: 1,
  },
  kimi: {
    requestsPerMinute: 30,
    minIntervalMs: 1000,
    maxConcurrency: 1,
  },
  glm: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  qwen: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  'qwen-ai': { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  minimax: {
    requestsPerMinute: 20,
    minIntervalMs: 1500,
    maxConcurrency: 1,
  },
  mimo: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  perplexity: {
    requestsPerMinute: 12,
    minIntervalMs: 3000,
    maxConcurrency: 1,
  },
  zai: {
    requestsPerMinute: 12,
    minIntervalMs: 2000,
    maxConcurrency: 1,
  },
}

/**
 * Resolve effective limits for an account.
 * - undefined field → provider default (soft, not persisted)
 * - 0 → unlimited for that dimension
 */
export function resolveAccountRateLimits(
  providerId: string,
  account: {
    requestsPerMinute?: number
    minIntervalMs?: number
    maxConcurrency?: number
  }
): AccountRateLimitDefaults {
  const base = PROVIDER_RATE_LIMIT_DEFAULTS[providerId] || GENERIC_WEB_RATE_LIMIT_DEFAULTS

  return {
    requestsPerMinute:
      account.requestsPerMinute === undefined ? base.requestsPerMinute : account.requestsPerMinute,
    minIntervalMs: account.minIntervalMs === undefined ? base.minIntervalMs : account.minIntervalMs,
    maxConcurrency:
      account.maxConcurrency === undefined ? base.maxConcurrency : account.maxConcurrency,
  }
}

/**
 * Defaults to persist when creating a new account.
 */
export function getCreateDefaultsForProvider(providerId: string): AccountRateLimitDefaults {
  return { ...(PROVIDER_RATE_LIMIT_DEFAULTS[providerId] || GENERIC_WEB_RATE_LIMIT_DEFAULTS) }
}
