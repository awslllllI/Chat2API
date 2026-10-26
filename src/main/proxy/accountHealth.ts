/**
 * Apply upstream error classification to account cooling / pause / auth state.
 */

import { AccountManager } from '../store/accounts'
import { loadBalancer } from './loadbalancer'
import {
  classifyUpstreamError,
  isEmptyAssistantContent,
  type UpstreamErrorClassification,
} from './upstreamErrorClassifier'

/**
 * Handle a failed upstream response for scheduling health.
 * Never maps ambiguous failures to auth unless classifier says so.
 */
export function applyUpstreamFailure(
  accountId: string,
  status: number | undefined,
  errorMessage: string | undefined
): UpstreamErrorClassification {
  const classification = classifyUpstreamError(status, errorMessage)
  applyClassification(accountId, classification)
  return classification
}

/**
 * Guard empty non-stream success bodies so we do not clear failure state.
 */
export function applyEmptySuccessGuard(accountId: string, body: unknown): boolean {
  if (!isEmptyAssistantContent(body)) {
    return false
  }
  const classification = classifyUpstreamError(undefined, undefined, { emptyContent: true })
  applyClassification(accountId, classification)
  return true
}

/**
 * Persist / memory effects for a classification.
 */
function applyClassification(accountId: string, classification: UpstreamErrorClassification): void {
  switch (classification.kind) {
    case 'ban_or_mute':
    case 'challenge':
      AccountManager.pause(accountId, classification.reason)
      loadBalancer.coolAccount(accountId, 300_000, classification.reason)
      console.warn(`[AccountHealth] paused ${accountId}: ${classification.kind} — ${classification.reason}`)
      break
    case 'rate_limit':
      loadBalancer.coolAccount(
        accountId,
        classification.coolDownMs || 60_000,
        classification.reason
      )
      console.warn(`[AccountHealth] cooling ${accountId}: rate_limit — ${classification.reason}`)
      break
    case 'auth':
      AccountManager.updateStatus(accountId, 'error', classification.reason)
      console.warn(`[AccountHealth] auth error ${accountId}: ${classification.reason}`)
      break
    case 'empty_success':
      loadBalancer.markAccountFailed(accountId, classification.reason)
      console.warn(`[AccountHealth] empty success ${accountId}`)
      break
    default:
      loadBalancer.markAccountFailed(accountId, classification.reason)
      break
  }
}
