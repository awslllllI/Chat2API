/**
 * In-memory account gate: RPM sliding window, min interval, concurrency.
 * Process-local; resets on app restart (dailyLimit remains in store).
 */

import type { AccountRateLimitDefaults } from './rateLimitDefaults'

export type GateBlockReason = 'rpm' | 'interval' | 'concurrency'

export interface GateAvailability {
  available: boolean
  reason?: GateBlockReason
  /** Suggested wait before retrying this account (ms) */
  retryAfterMs?: number
}

interface AccountGateState {
  /** Timestamps of dispatches in the last 60s */
  window: number[]
  lastDispatchAt: number
  inFlight: number
}

/**
 * Account-level rate gate used by the load balancer and chat routes.
 */
export class AccountGate {
  private states = new Map<string, AccountGateState>()

  /**
   * Ensure gate state exists for an account.
   */
  private getState(accountId: string): AccountGateState {
    let state = this.states.get(accountId)
    if (!state) {
      state = { window: [], lastDispatchAt: 0, inFlight: 0 }
      this.states.set(accountId, state)
    }
    return state
  }

  /**
   * Prune RPM window entries older than 60 seconds.
   */
  private pruneWindow(state: AccountGateState, now: number): void {
    const cutoff = now - 60_000
    state.window = state.window.filter((ts) => ts > cutoff)
  }

  /**
   * Check whether an account may accept a new upstream dispatch.
   */
  check(accountId: string, limits: AccountRateLimitDefaults): GateAvailability {
    const now = Date.now()
    const state = this.getState(accountId)
    this.pruneWindow(state, now)

    if (limits.maxConcurrency > 0 && state.inFlight >= limits.maxConcurrency) {
      return {
        available: false,
        reason: 'concurrency',
        retryAfterMs: Math.min(Math.max(limits.minIntervalMs || 1000, 1000), 15_000),
      }
    }

    if (limits.minIntervalMs > 0 && state.lastDispatchAt > 0) {
      const elapsed = now - state.lastDispatchAt
      if (elapsed < limits.minIntervalMs) {
        return {
          available: false,
          reason: 'interval',
          retryAfterMs: limits.minIntervalMs - elapsed,
        }
      }
    }

    if (limits.requestsPerMinute > 0 && state.window.length >= limits.requestsPerMinute) {
      const oldest = state.window[0]
      const retryAfterMs = Math.max(oldest + 60_000 - now, 500)
      return {
        available: false,
        reason: 'rpm',
        retryAfterMs,
      }
    }

    return { available: true }
  }

  /**
   * Reserve a slot before calling the upstream adapter.
   * Returns false if the gate rejects (rare race after select).
   */
  tryAcquire(accountId: string, limits: AccountRateLimitDefaults): boolean {
    const availability = this.check(accountId, limits)
    if (!availability.available) {
      return false
    }

    const now = Date.now()
    const state = this.getState(accountId)
    this.pruneWindow(state, now)
    state.inFlight += 1
    state.lastDispatchAt = now
    if (limits.requestsPerMinute > 0) {
      state.window.push(now)
    }
    return true
  }

  /**
   * Release in-flight slot after upstream finishes (success or failure).
   */
  release(accountId: string): void {
    const state = this.states.get(accountId)
    if (!state) return
    state.inFlight = Math.max(0, state.inFlight - 1)
  }

  /**
   * Reset gate state for an account (e.g. after manual resume).
   */
  reset(accountId: string): void {
    this.states.delete(accountId)
  }

  /**
   * Estimate how long until any of the given accounts might free up.
   * Capped so Agent clients do not wait or stampede.
   */
  estimateRetryAfterMs(
    accountIds: string[],
    limitResolver: (accountId: string) => AccountRateLimitDefaults
  ): number {
    let minWait = 5_000
    let found = false

    for (const id of accountIds) {
      const check = this.check(id, limitResolver(id))
      if (check.available) {
        return 1_000
      }
      if (check.retryAfterMs !== undefined) {
        minWait = found ? Math.min(minWait, check.retryAfterMs) : check.retryAfterMs
        found = true
      }
    }

    // Keep Retry-After short enough for clients (avoid timeout+retry storms)
    return Math.min(Math.max(Math.ceil(minWait), 1_000), 15_000)
  }
}

export const accountGate = new AccountGate()
export default accountGate
