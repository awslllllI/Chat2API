/**
 * Human Conversation Envelope (HCE) defaults per provider.
 * Shared by main (gate/persist) and renderer (form prefills).
 * Calibrated to heavy human web-chat upper bounds — NOT agent throughput.
 * Numbers are hypotheses (not official SLA). 0 on a field = unlimited for that dimension.
 */

export interface AccountRateLimitDefaults {
  /** Sliding-window requests per minute (spike fuse); 0 = unlimited */
  requestsPerMinute: number
  /**
   * Minimum ms after previous turn *ends* before next dispatch.
   * Applied with jitter at release time. 0 = unlimited.
   */
  minIntervalMs: number
  /** In-flight requests per account; 0 = unlimited */
  maxConcurrency: number
  /** Sliding-window turns per rolling hour; 0 = unlimited */
  requestsPerHour: number
  /** Soft daily turn cap persisted on account */
  dailyLimit: number
  /** Token-bucket burst capacity (turns); 0 = disable burst gate */
  burstCapacity: number
  /** Ms to refill one burst token; used with burstCapacity */
  burstRefillMs: number
  /** Prefer same account for this long (sticky); 0 = no sticky */
  stickyTtlMs: number
  /** Max new provider web sessions per rolling hour; 0 = unlimited */
  sessionCreatesPerHour: number
  /** After switching away from sticky, penalize the new account by this ms */
  switchPenaltyMs: number
  /** Jitter factor applied to minInterval (e.g. 0.2 => 0.8x–1.2x) */
  intervalJitterRatio: number
  /** Cap for Retry-After suggestions (ms) */
  retryAfterCapMs: number
}

/** Legacy loose defaults we migrate away from (DeepSeek pre-HCE). */
export const LEGACY_LOOSE_DEEPSEEK = {
  requestsPerMinute: 24,
  minIntervalMs: 1500,
} as const

/** Generic web HCE — still human-paced, slightly looser than DeepSeek. */
export const GENERIC_WEB_RATE_LIMIT_DEFAULTS: AccountRateLimitDefaults = {
  requestsPerMinute: 8,
  minIntervalMs: 20_000,
  maxConcurrency: 1,
  requestsPerHour: 36,
  dailyLimit: 150,
  burstCapacity: 6,
  burstRefillMs: 45_000,
  stickyTtlMs: 900_000,
  sessionCreatesPerHour: 6,
  switchPenaltyMs: 45_000,
  intervalJitterRatio: 0.2,
  retryAfterCapMs: 60_000,
}

/**
 * Provider-tuned HCE. DeepSeek is strictest (mute/ban reports).
 */
export const PROVIDER_RATE_LIMIT_DEFAULTS: Record<string, AccountRateLimitDefaults> = {
  deepseek: {
    requestsPerMinute: 6,
    minIntervalMs: 30_000,
    maxConcurrency: 1,
    requestsPerHour: 24,
    dailyLimit: 100,
    burstCapacity: 5,
    burstRefillMs: 60_000,
    stickyTtlMs: 900_000,
    sessionCreatesPerHour: 4,
    switchPenaltyMs: 60_000,
    intervalJitterRatio: 0.2,
    retryAfterCapMs: 60_000,
  },
  kimi: {
    requestsPerMinute: 8,
    minIntervalMs: 20_000,
    maxConcurrency: 1,
    requestsPerHour: 30,
    dailyLimit: 120,
    burstCapacity: 6,
    burstRefillMs: 50_000,
    stickyTtlMs: 900_000,
    sessionCreatesPerHour: 5,
    switchPenaltyMs: 45_000,
    intervalJitterRatio: 0.2,
    retryAfterCapMs: 60_000,
  },
  glm: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  qwen: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  'qwen-ai': { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  minimax: {
    ...GENERIC_WEB_RATE_LIMIT_DEFAULTS,
    requestsPerMinute: 6,
    minIntervalMs: 25_000,
    requestsPerHour: 28,
    dailyLimit: 120,
  },
  mimo: { ...GENERIC_WEB_RATE_LIMIT_DEFAULTS },
  perplexity: {
    ...GENERIC_WEB_RATE_LIMIT_DEFAULTS,
    requestsPerMinute: 4,
    minIntervalMs: 40_000,
    requestsPerHour: 18,
    dailyLimit: 80,
    burstCapacity: 4,
    burstRefillMs: 60_000,
    sessionCreatesPerHour: 3,
  },
  zai: {
    ...GENERIC_WEB_RATE_LIMIT_DEFAULTS,
    requestsPerMinute: 4,
    minIntervalMs: 30_000,
    requestsPerHour: 20,
    dailyLimit: 80,
    sessionCreatesPerHour: 3,
  },
}

/**
 * Defaults to show/persist when creating a new account.
 */
export function getCreateDefaultsForProvider(providerId: string): AccountRateLimitDefaults {
  return { ...(PROVIDER_RATE_LIMIT_DEFAULTS[providerId] || GENERIC_WEB_RATE_LIMIT_DEFAULTS) }
}
