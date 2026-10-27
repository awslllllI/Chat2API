/**
 * Human Conversation Envelope gate:
 * turn spacing (from turn end + jitter), burst bucket, RPM fuse, hourly window,
 * concurrency, session-create throttle, switch penalty.
 */

import type { AccountRateLimitDefaults } from './rateLimitDefaults'

export type GateBlockReason =
  | 'rpm'
  | 'interval'
  | 'concurrency'
  | 'burst'
  | 'hourly'
  | 'session_create'
  | 'switch_penalty'

export interface GateAvailability {
  available: boolean
  reason?: GateBlockReason
  /** Suggested wait before retrying this account (ms) */
  retryAfterMs?: number
}

interface AccountGateState {
  /** Timestamps of dispatches in the last 60s (RPM fuse) */
  minuteWindow: number[]
  /** Timestamps of dispatches in the last hour */
  hourWindow: number[]
  /** Timestamps of new provider web-session creates in the last hour */
  sessionCreateWindow: number[]
  /** Earliest time next turn may start (set on release with jitter / switch penalty) */
  nextAllowedAt: number
  inFlight: number
  /** Fractional burst tokens */
  burstTokens: number
  /** Last time burst tokens were refilled */
  burstUpdatedAt: number
}

/**
 * Account-level HCE gate used by the load balancer and chat routes.
 */
export class AccountGate {
  private states = new Map<string, AccountGateState>()

  /**
   * Ensure gate state exists for an account.
   */
  private getState(accountId: string, limits?: AccountRateLimitDefaults): AccountGateState {
    let state = this.states.get(accountId)
    if (!state) {
      const burstCap = limits?.burstCapacity && limits.burstCapacity > 0 ? limits.burstCapacity : 0
      state = {
        minuteWindow: [],
        hourWindow: [],
        sessionCreateWindow: [],
        nextAllowedAt: 0,
        inFlight: 0,
        burstTokens: burstCap > 0 ? burstCap : 0,
        burstUpdatedAt: Date.now(),
      }
      this.states.set(accountId, state)
    }
    return state
  }

  /**
   * Prune time windows older than the given horizon.
   */
  private prune(window: number[], now: number, horizonMs: number): number[] {
    const cutoff = now - horizonMs
    return window.filter((ts) => ts > cutoff)
  }

  /**
   * Refill burst tokens up to capacity based on elapsed time.
   */
  private refillBurst(state: AccountGateState, limits: AccountRateLimitDefaults, now: number): void {
    if (limits.burstCapacity <= 0 || limits.burstRefillMs <= 0) return
    if (state.burstTokens <= 0 && state.burstUpdatedAt === 0) {
      state.burstTokens = limits.burstCapacity
      state.burstUpdatedAt = now
      return
    }
    const elapsed = Math.max(0, now - state.burstUpdatedAt)
    const gained = elapsed / limits.burstRefillMs
    state.burstTokens = Math.min(limits.burstCapacity, state.burstTokens + gained)
    state.burstUpdatedAt = now
  }

  /**
   * Cap retry suggestions for clients (HCE: up to ~60s).
   */
  private capRetry(ms: number, limits: AccountRateLimitDefaults): number {
    const cap = limits.retryAfterCapMs > 0 ? limits.retryAfterCapMs : 60_000
    return Math.min(Math.max(Math.ceil(ms), 500), cap)
  }

  /**
   * Check whether an account may accept a new upstream dispatch.
   */
  check(accountId: string, limits: AccountRateLimitDefaults): GateAvailability {
    const now = Date.now()
    const state = this.getState(accountId, limits)
    state.minuteWindow = this.prune(state.minuteWindow, now, 60_000)
    state.hourWindow = this.prune(state.hourWindow, now, 3_600_000)
    this.refillBurst(state, limits, now)

    if (limits.maxConcurrency > 0 && state.inFlight >= limits.maxConcurrency) {
      return {
        available: false,
        reason: 'concurrency',
        retryAfterMs: this.capRetry(Math.max(limits.minIntervalMs || 5_000, 5_000), limits),
      }
    }

    if (state.nextAllowedAt > now) {
      const wait = state.nextAllowedAt - now
      const reason: GateBlockReason =
        wait > (limits.minIntervalMs || 0) * 1.5 ? 'switch_penalty' : 'interval'
      return {
        available: false,
        reason,
        retryAfterMs: this.capRetry(wait, limits),
      }
    }

    if (limits.burstCapacity > 0 && state.burstTokens < 1) {
      const need = 1 - state.burstTokens
      const refillMs = limits.burstRefillMs > 0 ? limits.burstRefillMs : 60_000
      return {
        available: false,
        reason: 'burst',
        retryAfterMs: this.capRetry(need * refillMs, limits),
      }
    }

    if (limits.requestsPerHour > 0 && state.hourWindow.length >= limits.requestsPerHour) {
      const oldest = state.hourWindow[0]
      return {
        available: false,
        reason: 'hourly',
        retryAfterMs: this.capRetry(Math.max(oldest + 3_600_000 - now, 1_000), limits),
      }
    }

    if (limits.requestsPerMinute > 0 && state.minuteWindow.length >= limits.requestsPerMinute) {
      const oldest = state.minuteWindow[0]
      return {
        available: false,
        reason: 'rpm',
        retryAfterMs: this.capRetry(Math.max(oldest + 60_000 - now, 500), limits),
      }
    }

    return { available: true }
  }

  /**
   * Reserve a slot before calling the upstream adapter.
   */
  tryAcquire(accountId: string, limits: AccountRateLimitDefaults): boolean {
    const availability = this.check(accountId, limits)
    if (!availability.available) {
      return false
    }

    const now = Date.now()
    const state = this.getState(accountId, limits)
    state.minuteWindow = this.prune(state.minuteWindow, now, 60_000)
    state.hourWindow = this.prune(state.hourWindow, now, 3_600_000)
    this.refillBurst(state, limits, now)

    state.inFlight += 1
    if (limits.requestsPerMinute > 0) state.minuteWindow.push(now)
    if (limits.requestsPerHour > 0) state.hourWindow.push(now)
    if (limits.burstCapacity > 0) {
      state.burstTokens = Math.max(0, state.burstTokens - 1)
      state.burstUpdatedAt = now
    }
    return true
  }

  /**
   * Release in-flight slot and schedule next-allowed time from turn end (+ jitter).
   */
  release(accountId: string, limits?: AccountRateLimitDefaults): void {
    const state = this.states.get(accountId)
    if (!state) return
    state.inFlight = Math.max(0, state.inFlight - 1)

    const now = Date.now()
    if (limits && limits.minIntervalMs > 0) {
      const jitter = limits.intervalJitterRatio || 0
      const factor = jitter > 0 ? 1 - jitter + Math.random() * jitter * 2 : 1
      const wait = Math.round(limits.minIntervalMs * factor)
      state.nextAllowedAt = Math.max(state.nextAllowedAt, now + wait)
    }
  }

  /**
   * Apply switch penalty so a newly selected account cannot fire immediately.
   */
  applySwitchPenalty(accountId: string, limits: AccountRateLimitDefaults): void {
    if (limits.switchPenaltyMs <= 0) return
    const now = Date.now()
    const state = this.getState(accountId, limits)
    state.nextAllowedAt = Math.max(state.nextAllowedAt, now + limits.switchPenaltyMs)
  }

  /**
   * Check whether a new provider web session may be created.
   */
  checkSessionCreate(accountId: string, limits: AccountRateLimitDefaults): GateAvailability {
    if (limits.sessionCreatesPerHour <= 0) return { available: true }
    const now = Date.now()
    const state = this.getState(accountId, limits)
    state.sessionCreateWindow = this.prune(state.sessionCreateWindow, now, 3_600_000)
    if (state.sessionCreateWindow.length >= limits.sessionCreatesPerHour) {
      const oldest = state.sessionCreateWindow[0]
      return {
        available: false,
        reason: 'session_create',
        retryAfterMs: this.capRetry(Math.max(oldest + 3_600_000 - now, 1_000), limits),
      }
    }
    return { available: true }
  }

  /**
   * Record a new provider web session create.
   */
  recordSessionCreate(accountId: string, limits: AccountRateLimitDefaults): void {
    if (limits.sessionCreatesPerHour <= 0) return
    const now = Date.now()
    const state = this.getState(accountId, limits)
    state.sessionCreateWindow = this.prune(state.sessionCreateWindow, now, 3_600_000)
    state.sessionCreateWindow.push(now)
  }

  /**
   * Snapshot for UI / diagnostics (no secrets).
   */
  getEnvelopeSnapshot(accountId: string, limits: AccountRateLimitDefaults): {
    inFlight: number
    minuteUsed: number
    hourUsed: number
    burstTokens: number
    sessionCreatesUsed: number
    nextAllowedAt: number
    available: boolean
    blockReason?: GateBlockReason
    retryAfterMs?: number
  } {
    const check = this.check(accountId, limits)
    const state = this.getState(accountId, limits)
    const now = Date.now()
    return {
      inFlight: state.inFlight,
      minuteUsed: this.prune(state.minuteWindow, now, 60_000).length,
      hourUsed: this.prune(state.hourWindow, now, 3_600_000).length,
      burstTokens: Math.round(state.burstTokens * 100) / 100,
      sessionCreatesUsed: this.prune(state.sessionCreateWindow, now, 3_600_000).length,
      nextAllowedAt: state.nextAllowedAt,
      available: check.available,
      blockReason: check.reason,
      retryAfterMs: check.retryAfterMs,
    }
  }

  /**
   * Reset gate state for an account (e.g. after manual resume).
   */
  reset(accountId: string): void {
    this.states.delete(accountId)
  }

  /**
   * Estimate how long until any of the given accounts might free up.
   */
  estimateRetryAfterMs(
    accountIds: string[],
    limitResolver: (accountId: string) => AccountRateLimitDefaults,
  ): number {
    let minWait = 5_000
    let found = false
    let cap = 60_000

    for (const id of accountIds) {
      const limits = limitResolver(id)
      if (limits.retryAfterCapMs > 0) cap = Math.max(cap, limits.retryAfterCapMs)
      const check = this.check(id, limits)
      if (check.available) {
        return 1_000
      }
      if (check.retryAfterMs !== undefined) {
        minWait = found ? Math.min(minWait, check.retryAfterMs) : check.retryAfterMs
        found = true
      }
    }

    return Math.min(Math.max(Math.ceil(minWait), 1_000), cap)
  }
}

export const accountGate = new AccountGate()
export default accountGate
