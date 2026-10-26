/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin / Fill First / Failover within the same provider (S1).
 * Integrates account gate (RPM / interval / concurrency) and cooling / paused.
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

export interface SelectAccountResult {
  selection: AccountSelection | null
  /** When selection is null, suggested Retry-After seconds for clients */
  retryAfterSeconds: number
  /** Why no account was selected */
  unavailabilityReason?: string
}

/**
 * Load Balancer with same-provider switching and rate gates.
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private coolDowns: Map<string, CoolDownState> = new Map()
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
   * Select account for a model (same-provider multi-account only for a chosen provider set).
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): AccountSelection | null {
    return this.selectAccountDetailed(model, strategy, preferredProviderId, preferredAccountId).selection
  }

  /**
   * Select account and return retry hints when none available.
   */
  selectAccountDetailed(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): SelectAccountResult {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')

    if (candidates.length === 0) {
      const relatedIds = this.collectRelatedAccountIds(model, preferredProviderId)
      const retryAfterMs = accountGate.estimateRetryAfterMs(relatedIds, (id) => {
        const acc = storeManager.getAccountById(id)
        const providerId = acc?.providerId || preferredProviderId || 'unknown'
        return resolveAccountRateLimits(providerId, acc || {})
      })
      // Also consider cooling remaining time
      let coolingWait = retryAfterMs
      for (const id of relatedIds) {
        const info = this.getCoolDownInfo(id)
        if (info) {
          coolingWait = Math.min(coolingWait, Math.max(info.until - Date.now(), 1000))
        }
      }
      const retryAfterSeconds = Math.min(Math.max(Math.ceil(Math.min(retryAfterMs, coolingWait) / 1000), 1), 15)
      console.log(
        `[LoadBalancer] No available account for model="${model}" provider=${preferredProviderId || '*'} retryAfter=${retryAfterSeconds}s`
      )
      return {
        selection: null,
        retryAfterSeconds,
        unavailabilityReason: 'no_available_account_or_rate_limited',
      }
    }

    if (preferredAccountId) {
      const preferred = candidates.find((c) => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountCooling(preferredAccountId)) {
        return { selection: preferred, retryAfterSeconds: 0 }
      }
    }

    let selected: AccountSelection
    if (strategy === 'fill-first') {
      selected = this.selectFillFirst(candidates)
    } else if (strategy === 'failover') {
      selected = this.selectFailover(candidates)
    } else {
      selected = this.selectRoundRobin(candidates)
    }

    console.log(
      `[LoadBalancer] Selected account ${selected.account.name} (${selected.account.id}) provider=${selected.provider.id}`
    )
    return { selection: selected, retryAfterSeconds: 0 }
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
   * Get available accounts list (gate + status + cooling filtered).
   */
  private getAvailableAccounts(
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false
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
        `[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`
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

    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }

    const limits = resolveAccountRateLimits(providerId, account)
    const gate = accountGate.check(account.id, limits)
    if (!gate.available) {
      console.log(
        `[LoadBalancer] Account ${account.id} gated: ${gate.reason} retryAfterMs=${gate.retryAfterMs}`
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
      (m) => m.displayName.toLowerCase() === model.toLowerCase()
    )

    if (effectiveModel) {
      return effectiveModel.actualModelId
    }

    const config = storeManager.getConfig()
    const mapping = config.modelMappings[model]

    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      const actualModel = mapping.actualModel
      const actualEffectiveModel = effectiveModels.find(
        (m) => m.displayName.toLowerCase() === actualModel.toLowerCase()
      )
      if (actualEffectiveModel) {
        return actualEffectiveModel.actualModelId
      }
      return actualModel
    }

    return model
  }

  /**
   * Round Robin within candidate set (typically same provider when model maps to one).
   */
  private selectRoundRobin(candidates: AccountSelection[]): AccountSelection {
    const providerIds = [...new Set(candidates.map((c) => c.provider.id))]
    const key = providerIds.join(',')

    const currentIndex = this.roundRobinIndex.get(key) || 0
    const selected = candidates[currentIndex % candidates.length]

    this.roundRobinIndex.set(key, (currentIndex + 1) % candidates.length)

    return selected
  }

  /**
   * Fill First: prefer least-used today.
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
   * Failover: prefer non-cooling accounts.
   */
  private selectFailover(candidates: AccountSelection[]): AccountSelection {
    const healthyCandidates = candidates.filter((c) => !this.isAccountCooling(c.account.id))

    if (healthyCandidates.length > 0) {
      return this.selectRoundRobin(healthyCandidates)
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
   * Reset Round Robin index.
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex.clear()
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
