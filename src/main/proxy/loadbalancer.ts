/**
 * Proxy Service Module - Load Balancer
 * Same-provider switching with Human Conversation Envelope + sticky accounts.
 */

import { Account, Provider, LoadBalanceStrategy } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'
import { accountGate } from './accountGate'
import { resolveAccountRateLimits } from './rateLimitDefaults'

export type CoolDownKind = 'failure' | 'rate_limit'

interface CoolDownState {
  count: number
  lastFailTime: number
  until: number
  kind: CoolDownKind
  reason?: string
}

interface StickyState {
  accountId: string
  until: number
}

/** Client-facing reason when no account can be selected. */
export type AccountUnavailabilityReason =
  | 'no_available_account_or_rate_limited'
  | 'accounts_unavailable'

export interface SelectAccountResult {
  selection: AccountSelection | null
  /** When selection is null, suggested Retry-After seconds for clients (0 = do not retry as rate-limit) */
  retryAfterSeconds: number
  /** Why no account was selected */
  unavailabilityReason?: AccountUnavailabilityReason
  /** Short status summary for logs/UI (no secrets) */
  unavailabilityDetail?: string
}

/**
 * Load Balancer with sticky same-provider switching and HCE gates.
 */
export class LoadBalancer {
  private coolDowns: Map<string, CoolDownState> = new Map()
  /** Sticky account per provider */
  private stickyByProvider: Map<string, StickyState> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60_000

  /**
   * Mark account as failed; after threshold enters cooling.
   */
  markAccountFailed(accountId: string, reason?: string): void {
    const current = this.coolDowns.get(accountId)
    const count = (current?.count || 0) + 1
    const now = Date.now()
    this.coolDowns.set(accountId, {
      count,
      lastFailTime: now,
      until: count >= LoadBalancer.FAIL_THRESHOLD ? now + LoadBalancer.RECOVERY_TIME : 0,
      kind: 'failure',
      reason,
    })
    this.clearStickyIfAccount(accountId)
  }

  /**
   * Put account into rate-limit cooling without requiring failure threshold.
   */
  coolAccount(accountId: string, durationMs: number, reason?: string): void {
    const now = Date.now()
    const current = this.coolDowns.get(accountId)
    this.coolDowns.set(accountId, {
      count: Math.max(current?.count || 0, LoadBalancer.FAIL_THRESHOLD),
      lastFailTime: now,
      until: now + Math.min(Math.max(durationMs, 5_000), 300_000),
      kind: 'rate_limit',
      reason,
    })
    this.clearStickyIfAccount(accountId)
  }

  /**
   * Clear account failure / cooling status.
   */
  clearAccountFailure(accountId: string): void {
    this.coolDowns.delete(accountId)
  }

  /**
   * Whether account is in cooling window.
   */
  isAccountCooling(accountId: string): boolean {
    const state = this.coolDowns.get(accountId)
    if (!state || !state.until) return false
    if (Date.now() >= state.until) {
      this.coolDowns.delete(accountId)
      return false
    }
    return true
  }

  /**
   * Get cooling info for UI/logs.
   */
  getCoolDownInfo(accountId: string): { until: number; reason?: string; kind: CoolDownKind } | null {
    if (!this.isAccountCooling(accountId)) return null
    const state = this.coolDowns.get(accountId)!
    return { until: state.until, reason: state.reason, kind: state.kind }
  }

  /**
   * Select account for a model (same-provider multi-account only).
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string,
  ): AccountSelection | null {
    return this.selectAccountDetailed(model, strategy, preferredProviderId, preferredAccountId).selection
  }

  /**
   * Select account and return retry hints when none available.
   * Default behaviour is sticky; round-robin is no longer used for healthy rotation.
   */
  selectAccountDetailed(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string,
  ): SelectAccountResult {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')

    if (candidates.length === 0) {
      const relatedIds = this.collectRelatedAccountIds(model, preferredProviderId)
      const diagnosis = this.diagnoseUnavailability(relatedIds)

      // Auth/paused/error (or no accounts): do not masquerade as rate-limit with Retry-After storms.
      if (diagnosis.kind === 'accounts_unavailable') {
        console.log(
          `[LoadBalancer] No usable account for model="${model}" provider=${preferredProviderId || '*'} detail=${diagnosis.detail}`,
        )
        return {
          selection: null,
          retryAfterSeconds: 0,
          unavailabilityReason: 'accounts_unavailable',
          unavailabilityDetail: diagnosis.detail,
        }
      }

      const retryAfterMs = accountGate.estimateRetryAfterMs(relatedIds, (id) => {
        const acc = storeManager.getAccountById(id)
        const providerId = acc?.providerId || preferredProviderId || 'unknown'
        return resolveAccountRateLimits(providerId, acc || {})
      })
      let coolingWait = retryAfterMs
      for (const id of relatedIds) {
        const info = this.getCoolDownInfo(id)
        if (info) {
          coolingWait = Math.min(coolingWait, Math.max(info.until - Date.now(), 1000))
        }
      }
      const waitMs = Math.min(retryAfterMs, coolingWait)
      const retryAfterSeconds = Math.min(Math.max(Math.ceil(waitMs / 1000), 1), 60)
      console.log(
        `[LoadBalancer] No available account for model="${model}" provider=${preferredProviderId || '*'} retryAfter=${retryAfterSeconds}s detail=${diagnosis.detail}`,
      )
      return {
        selection: null,
        retryAfterSeconds,
        unavailabilityReason: 'no_available_account_or_rate_limited',
        unavailabilityDetail: diagnosis.detail,
      }
    }

    if (preferredAccountId) {
      const preferred = candidates.find((c) => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountCooling(preferredAccountId)) {
        this.setSticky(preferred.provider.id, preferred.account.id, preferred.provider.id, preferred.account)
        return { selection: preferred, retryAfterSeconds: 0 }
      }
    }

    // Sticky: prefer current sticky account while still available
    const providerId = candidates[0]?.provider.id
    if (providerId) {
      const sticky = this.getSticky(providerId)
      if (sticky) {
        const stickyCandidate = candidates.find((c) => c.account.id === sticky.accountId)
        if (stickyCandidate) {
          console.log(
            `[LoadBalancer] Sticky account ${stickyCandidate.account.name} (${stickyCandidate.account.id}) provider=${providerId}`,
          )
          return { selection: stickyCandidate, retryAfterSeconds: 0 }
        }
        this.stickyByProvider.delete(providerId)
      }
    }

    let selected: AccountSelection
    if (strategy === 'fill-first') {
      selected = this.selectFillFirst(candidates)
    } else if (strategy === 'failover') {
      selected = this.selectFailover(candidates)
    } else {
      // HCE: no healthy round-robin — pick fill-first (least used today)
      selected = this.selectFillFirst(candidates)
    }

    this.commitSelection(selected)

    console.log(
      `[LoadBalancer] Selected account ${selected.account.name} (${selected.account.id}) provider=${selected.provider.id}`,
    )
    return { selection: selected, retryAfterSeconds: 0 }
  }

  /**
   * After choosing a non-sticky account, set sticky and apply switch penalty if switching.
   */
  private commitSelection(selected: AccountSelection): void {
    const providerId = selected.provider.id
    const previous = this.stickyByProvider.get(providerId)
    const limits = resolveAccountRateLimits(providerId, selected.account)

    if (previous && previous.accountId !== selected.account.id) {
      accountGate.applySwitchPenalty(selected.account.id, limits)
      console.log(
        `[LoadBalancer] Switch penalty ${limits.switchPenaltyMs}ms on ${selected.account.id} (was ${previous.accountId})`,
      )
    }

    this.setSticky(providerId, selected.account.id, providerId, selected.account)
  }

  /**
   * Remember sticky account for a provider.
   */
  private setSticky(
    providerId: string,
    accountId: string,
    _providerKey: string,
    account: Account,
  ): void {
    const limits = resolveAccountRateLimits(providerId, account)
    const ttl = limits.stickyTtlMs > 0 ? limits.stickyTtlMs : 900_000
    this.stickyByProvider.set(providerId, {
      accountId,
      until: Date.now() + ttl,
    })
  }

  /**
   * Read sticky if still valid.
   */
  private getSticky(providerId: string): StickyState | null {
    const sticky = this.stickyByProvider.get(providerId)
    if (!sticky) return null
    if (Date.now() >= sticky.until) {
      this.stickyByProvider.delete(providerId)
      return null
    }
    return sticky
  }

  /**
   * Clear sticky binding when the sticky account fails / cools.
   */
  private clearStickyIfAccount(accountId: string): void {
    for (const [providerId, sticky] of this.stickyByProvider.entries()) {
      if (sticky.accountId === accountId) {
        this.stickyByProvider.delete(providerId)
      }
    }
  }

  /**
   * Collect account ids that could serve this model (for retry estimate).
   */
  private collectRelatedAccountIds(model: string, preferredProviderId?: string): string[] {
    const providers = storeManager.getProviders().filter((p) => p.enabled)
    const ids: string[] = []
    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) continue
      if (!this.providerSupportsModel(provider, model)) continue
      for (const account of storeManager.getAccountsByProviderId(provider.id, true)) {
        ids.push(account.id)
      }
    }
    return ids
  }

  /**
   * Distinguish permanent account unavailability (auth/paused/error) from temporary HCE/cooling.
   */
  private diagnoseUnavailability(
    relatedIds: string[],
  ): { kind: AccountUnavailabilityReason; detail: string } {
    if (relatedIds.length === 0) {
      return { kind: 'accounts_unavailable', detail: 'no_accounts_for_model' }
    }

    let active = 0
    let paused = 0
    let error = 0
    let otherInactive = 0
    let cooling = 0
    let gated = 0
    let daily = 0

    for (const id of relatedIds) {
      const account = storeManager.getAccountById(id)
      if (!account) {
        otherInactive += 1
        continue
      }
      if (account.status !== 'active') {
        if (account.status === 'paused') paused += 1
        else if (account.status === 'error') error += 1
        else otherInactive += 1
        continue
      }
      active += 1
      if (this.isAccountCooling(id)) {
        cooling += 1
        continue
      }
      const limits = resolveAccountRateLimits(account.providerId, account)
      const dailyCap =
        account.dailyLimit !== undefined && account.dailyLimit > 0
          ? account.dailyLimit
          : limits.dailyLimit
      if (dailyCap > 0 && account.todayUsed && account.todayUsed >= dailyCap) {
        daily += 1
        continue
      }
      const gate = accountGate.check(id, limits)
      if (!gate.available) gated += 1
    }

    const detail = `active=${active} paused=${paused} error=${error} inactive=${otherInactive} cooling=${cooling} gated=${gated} daily=${daily}`

    // No schedulable active accounts left → client should not treat as rate-limit.
    if (active === 0) {
      return { kind: 'accounts_unavailable', detail }
    }

    return { kind: 'no_available_account_or_rate_limited', detail }
  }

  /**
   * Get available accounts list (gate + status + cooling filtered).
   */
  private getAvailableAccounts(
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false,
  ): AccountSelection[] {
    const providers = storeManager.getProviders().filter((p) => p.enabled)
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) {
        continue
      }

      if (!this.providerSupportsModel(provider, model)) {
        continue
      }

      const accounts = storeManager
        .getAccountsByProviderId(provider.id, true)
        .filter((account) => this.isAccountAvailable(account, provider.id))
        .filter((account) => !excludeFailed || !this.isAccountCooling(account.id))

      console.log(
        `[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`,
      )

      for (const account of accounts) {
        candidates.push({
          account,
          provider,
          actualModel: this.mapModel(model, provider),
        })
      }
    }

    return candidates
  }

  /**
   * Check if provider supports model.
   */
  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) {
      return true
    }

    const normalizedModel = model.toLowerCase()
    const supported = effectiveModels.some((m) => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModel
    })

    if (supported) {
      return true
    }

    const config = storeManager.getConfig()
    const globalMapping = config.modelMappings[model]
    if (globalMapping) {
      if (globalMapping.preferredProviderId) {
        if (globalMapping.preferredProviderId === provider.id) {
          return true
        }
        return false
      }

      const actualModel = globalMapping.actualModel
      const normalizedActualModel = actualModel.toLowerCase()
      const actualSupported = effectiveModels.some((m) => {
        const normalizedSupported = m.displayName.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedActualModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedActualModel
      })

      if (actualSupported) {
        return true
      }
    }

    return false
  }

  /**
   * Check if account can be scheduled (status, daily, gate, cooling).
   */
  private isAccountAvailable(account: Account, providerId: string): boolean {
    if (account.status !== 'active') {
      return false
    }

    if (this.isAccountCooling(account.id)) {
      return false
    }

    const limits = resolveAccountRateLimits(providerId, account)
    const dailyCap =
      account.dailyLimit !== undefined && account.dailyLimit > 0
        ? account.dailyLimit
        : limits.dailyLimit
    if (dailyCap > 0 && account.todayUsed && account.todayUsed >= dailyCap) {
      return false
    }

    const gate = accountGate.check(account.id, limits)
    if (!gate.available) {
      console.log(
        `[LoadBalancer] Account ${account.id} gated: ${gate.reason} retryAfterMs=${gate.retryAfterMs}`,
      )
      return false
    }

    return true
  }

  /**
   * Map model name for a provider.
   */
  private mapModel(model: string, provider: Provider): string {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const effectiveModel = effectiveModels.find(
      (m) => m.displayName.toLowerCase() === model.toLowerCase(),
    )

    if (effectiveModel) {
      return effectiveModel.actualModelId
    }

    const config = storeManager.getConfig()
    const mapping = config.modelMappings[model]

    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      const actualModel = mapping.actualModel
      const actualEffectiveModel = effectiveModels.find(
        (m) => m.displayName.toLowerCase() === actualModel.toLowerCase(),
      )
      if (actualEffectiveModel) {
        return actualEffectiveModel.actualModelId
      }
      return actualModel
    }

    return model
  }

  /**
   * Fill First: prefer least-used today (sticky-friendly stable pick).
   */
  private selectFillFirst(candidates: AccountSelection[]): AccountSelection {
    return candidates.reduce((best, current) => {
      const bestUsed = best.account.todayUsed || 0
      const currentUsed = current.account.todayUsed || 0

      if (currentUsed < bestUsed) {
        return current
      }

      if (currentUsed === bestUsed) {
        const bestLastUsed = best.account.lastUsed || 0
        const currentLastUsed = current.account.lastUsed || 0

        if (currentLastUsed < bestLastUsed) {
          return current
        }
      }

      return best
    })
  }

  /**
   * Failover: prefer non-cooling accounts, then fill-first.
   */
  private selectFailover(candidates: AccountSelection[]): AccountSelection {
    const healthyCandidates = candidates.filter((c) => !this.isAccountCooling(c.account.id))

    if (healthyCandidates.length > 0) {
      return this.selectFillFirst(healthyCandidates)
    }

    const sortedCandidates = [...candidates].sort((a, b) => {
      const failureA = this.coolDowns.get(a.account.id)
      const failureB = this.coolDowns.get(b.account.id)

      const countA = failureA ? failureA.count : 0
      const countB = failureB ? failureB.count : 0

      if (countA !== countB) {
        return countA - countB
      }

      const timeA = failureA ? failureA.lastFailTime : 0
      const timeB = failureB ? failureB.lastFailTime : 0

      return timeA - timeB
    })

    return sortedCandidates[0]
  }

  /**
   * Reset sticky state (tests / manual).
   */
  resetRoundRobinIndex(): void {
    this.stickyByProvider.clear()
  }

  /**
   * Get available account count.
   */
  getAvailableAccountCount(model: string, providerId?: string): number {
    return this.getAvailableAccounts(model, providerId).length
  }

  /**
   * Get all available models.
   */
  getAvailableModels(): string[] {
    const providers = storeManager.getProviders().filter((p) => p.enabled)
    const models = new Set<string>()

    for (const provider of providers) {
      const accounts = storeManager
        .getAccountsByProviderId(provider.id)
        .filter((account) => this.isAccountAvailable(account, provider.id))

      if (accounts.length > 0) {
        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        effectiveModels.forEach((m) => models.add(m.displayName))
      }
    }

    return [...models]
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
