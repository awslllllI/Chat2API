/**
 * Human Conversation Envelope helpers used by main-process gate / persist.
 * Numeric defaults live in shared so the renderer can prefill the same values.
 */

export {
  GENERIC_WEB_RATE_LIMIT_DEFAULTS,
  LEGACY_LOOSE_DEEPSEEK,
  PROVIDER_RATE_LIMIT_DEFAULTS,
  getCreateDefaultsForProvider,
  type AccountRateLimitDefaults,
} from '../../shared/rateLimitDefaults.ts'

import {
  GENERIC_WEB_RATE_LIMIT_DEFAULTS,
  LEGACY_LOOSE_DEEPSEEK,
  PROVIDER_RATE_LIMIT_DEFAULTS,
  type AccountRateLimitDefaults,
} from '../../shared/rateLimitDefaults.ts'

export type AccountRateLimitFields = {
  requestsPerMinute?: number
  minIntervalMs?: number
  maxConcurrency?: number
  requestsPerHour?: number
  dailyLimit?: number
  burstCapacity?: number
  burstRefillMs?: number
  stickyTtlMs?: number
  sessionCreatesPerHour?: number
  switchPenaltyMs?: number
}

/**
 * Resolve effective HCE limits for an account.
 * - undefined field → provider default
 * - 0 → unlimited for that dimension (where applicable)
 */
export function resolveAccountRateLimits(
  providerId: string,
  account: AccountRateLimitFields,
): AccountRateLimitDefaults {
  const base = PROVIDER_RATE_LIMIT_DEFAULTS[providerId] || GENERIC_WEB_RATE_LIMIT_DEFAULTS

  return {
    requestsPerMinute:
      account.requestsPerMinute === undefined ? base.requestsPerMinute : account.requestsPerMinute,
    minIntervalMs: account.minIntervalMs === undefined ? base.minIntervalMs : account.minIntervalMs,
    maxConcurrency:
      account.maxConcurrency === undefined ? base.maxConcurrency : account.maxConcurrency,
    requestsPerHour:
      account.requestsPerHour === undefined ? base.requestsPerHour : account.requestsPerHour,
    dailyLimit: account.dailyLimit === undefined ? base.dailyLimit : account.dailyLimit,
    burstCapacity: account.burstCapacity === undefined ? base.burstCapacity : account.burstCapacity,
    burstRefillMs: account.burstRefillMs === undefined ? base.burstRefillMs : account.burstRefillMs,
    stickyTtlMs: account.stickyTtlMs === undefined ? base.stickyTtlMs : account.stickyTtlMs,
    sessionCreatesPerHour:
      account.sessionCreatesPerHour === undefined
        ? base.sessionCreatesPerHour
        : account.sessionCreatesPerHour,
    switchPenaltyMs:
      account.switchPenaltyMs === undefined ? base.switchPenaltyMs : account.switchPenaltyMs,
    intervalJitterRatio: base.intervalJitterRatio,
    retryAfterCapMs: base.retryAfterCapMs,
  }
}

/**
 * Detect pre-HCE loose DeepSeek (or similar) persisted values that should be migrated.
 */
export function shouldMigrateLegacyLooseLimits(
  providerId: string,
  account: AccountRateLimitFields,
): boolean {
  if (providerId === 'deepseek') {
    return (
      account.requestsPerMinute === LEGACY_LOOSE_DEEPSEEK.requestsPerMinute &&
      account.minIntervalMs === LEGACY_LOOSE_DEEPSEEK.minIntervalMs
    )
  }
  if (
    typeof account.minIntervalMs === 'number' &&
    account.minIntervalMs > 0 &&
    account.minIntervalMs <= 2000 &&
    typeof account.requestsPerMinute === 'number' &&
    account.requestsPerMinute >= 20
  ) {
    return true
  }
  return false
}

/**
 * Build persisted HCE field patch for migration / create.
 */
export function toPersistedRateLimitPatch(
  defaults: AccountRateLimitDefaults,
): Required<
  Pick<
    AccountRateLimitFields,
    | 'requestsPerMinute'
    | 'minIntervalMs'
    | 'maxConcurrency'
    | 'requestsPerHour'
    | 'dailyLimit'
    | 'burstCapacity'
    | 'burstRefillMs'
    | 'stickyTtlMs'
    | 'sessionCreatesPerHour'
    | 'switchPenaltyMs'
  >
> {
  return {
    requestsPerMinute: defaults.requestsPerMinute,
    minIntervalMs: defaults.minIntervalMs,
    maxConcurrency: defaults.maxConcurrency,
    requestsPerHour: defaults.requestsPerHour,
    dailyLimit: defaults.dailyLimit,
    burstCapacity: defaults.burstCapacity,
    burstRefillMs: defaults.burstRefillMs,
    stickyTtlMs: defaults.stickyTtlMs,
    sessionCreatesPerHour: defaults.sessionCreatesPerHour,
    switchPenaltyMs: defaults.switchPenaltyMs,
  }
}
