/**
 * Admission wait: when HCE blocks only because the envelope has not elapsed yet,
 * sleep inside the proxy (up to retryAfterCap) and retry select/acquire instead of
 * returning 429 that clients (e.g. dsh) may storm-retry.
 */

import type { LoadBalanceStrategy } from '../store/types'
import type { AccountRateLimitDefaults } from './rateLimitDefaults'
import { resolveAccountRateLimits } from './rateLimitDefaults'
import { accountGate } from './accountGate'
import type { SelectAccountResult } from './loadbalancer'
import type { AccountSelection } from './types'

const DEFAULT_CAP_MS = 60_000
const MAX_SELECT_ROUNDS = 2
const MAX_ACQUIRE_ROUNDS = 2

/**
 * Sleep for the given milliseconds; rejects if the abort signal fires.
 */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  const wait = Math.max(0, Math.ceil(ms))
  if (wait <= 0) return Promise.resolve()
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Client aborted'), { code: 'CLIENT_ABORTED' }))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, wait)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('Client aborted'), { code: 'CLIENT_ABORTED' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Whether a retry-after delay is short enough to wait server-side.
 */
export function shouldAdmissionWait(retryAfterMs: number, capMs: number = DEFAULT_CAP_MS): boolean {
  return retryAfterMs > 0 && retryAfterMs <= capMs
}

export type AdmissionSelectResult = SelectAccountResult & {
  waitedMs: number
}

/**
 * Select an account, waiting when the only issue is a temporary HCE/cooling gate.
 */
export async function selectAccountWithAdmissionWait(
  model: string,
  strategy: LoadBalanceStrategy,
  preferredProviderId?: string,
  preferredAccountId?: string,
  capMs: number = DEFAULT_CAP_MS,
  signal?: AbortSignal,
): Promise<AdmissionSelectResult> {
  // Lazy import keeps unit tests for acquire/wait free of electron-store.
  const { loadBalancer } = await import('./loadbalancer')
  let waitedMs = 0
  let last: SelectAccountResult = {
    selection: null,
    retryAfterSeconds: 5,
    unavailabilityReason: 'no_available_account_or_rate_limited',
  }

  for (let round = 0; round < MAX_SELECT_ROUNDS; round += 1) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Client aborted'), { code: 'CLIENT_ABORTED' })
    }
    last = loadBalancer.selectAccountDetailed(
      model,
      strategy,
      preferredProviderId,
      preferredAccountId,
    )
    if (last.selection) {
      return { ...last, waitedMs }
    }

    // Auth/paused/error: waiting cannot create a usable account.
    if (last.unavailabilityReason === 'accounts_unavailable') {
      break
    }

    const retryMs = Math.max((last.retryAfterSeconds || 1) * 1000, 1000)
    if (round >= MAX_SELECT_ROUNDS - 1 || !shouldAdmissionWait(retryMs, capMs)) {
      break
    }

    console.log(
      `[AdmissionWait] No account for model=${model}; waiting ${retryMs}ms before reselect (round ${round + 1})`,
    )
    await sleepMs(retryMs, signal)
    waitedMs += retryMs
  }

  return { ...last, waitedMs }
}

export type AdmissionAcquireResult = {
  acquired: boolean
  waitedMs: number
  retryAfterMs?: number
  reason?: string
}

/**
 * Try to acquire the gate; if blocked by interval/burst/switch within cap, wait and retry.
 */
export async function tryAcquireWithAdmissionWait(
  accountId: string,
  limits: AccountRateLimitDefaults,
  capMs: number = DEFAULT_CAP_MS,
  signal?: AbortSignal,
): Promise<AdmissionAcquireResult> {
  let waitedMs = 0

  for (let round = 0; round < MAX_ACQUIRE_ROUNDS; round += 1) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Client aborted'), { code: 'CLIENT_ABORTED' })
    }
    const check = accountGate.check(accountId, limits)
    if (!check.available) {
      const retryMs = check.retryAfterMs ?? limits.minIntervalMs ?? 5_000
      if (round >= MAX_ACQUIRE_ROUNDS - 1 || !shouldAdmissionWait(retryMs, capMs)) {
        return {
          acquired: false,
          waitedMs,
          retryAfterMs: retryMs,
          reason: check.reason || 'busy',
        }
      }
      console.log(
        `[AdmissionWait] Account ${accountId} gated (${check.reason}); waiting ${retryMs}ms (round ${round + 1})`,
      )
      await sleepMs(retryMs, signal)
      waitedMs += retryMs
      continue
    }

    if (accountGate.tryAcquire(accountId, limits)) {
      return { acquired: true, waitedMs }
    }

    // Race: became busy between check and acquire
    const raced = accountGate.check(accountId, limits)
    const retryMs = raced.retryAfterMs ?? 1_000
    if (round >= MAX_ACQUIRE_ROUNDS - 1 || !shouldAdmissionWait(retryMs, capMs)) {
      return {
        acquired: false,
        waitedMs,
        retryAfterMs: retryMs,
        reason: raced.reason || 'busy',
      }
    }
    await sleepMs(retryMs, signal)
    waitedMs += retryMs
  }

  return { acquired: false, waitedMs, retryAfterMs: 5_000, reason: 'busy' }
}

/**
 * Build an AbortSignal that fires when the Koa/HTTP client disconnects.
 */
export function clientAbortSignal(req: {
  aborted?: boolean
  on?: (event: string, listener: () => void) => void
  off?: (event: string, listener: () => void) => void
}): AbortSignal {
  const controller = new AbortController()
  if (req.aborted) {
    controller.abort()
    return controller.signal
  }
  const onClose = () => controller.abort()
  req.on?.('close', onClose)
  req.on?.('aborted', onClose)
  controller.signal.addEventListener(
    'abort',
    () => {
      req.off?.('close', onClose)
      req.off?.('aborted', onClose)
    },
    { once: true },
  )
  return controller.signal
}

/**
 * Resolve wait cap from provider defaults / account limits.
 */
export function resolveAdmissionCapMs(
  providerId: string,
  account?: { requestsPerMinute?: number; minIntervalMs?: number } | null,
): number {
  const limits = resolveAccountRateLimits(providerId, account || {})
  return limits.retryAfterCapMs > 0 ? limits.retryAfterCapMs : DEFAULT_CAP_MS
}

export type { AccountSelection }
