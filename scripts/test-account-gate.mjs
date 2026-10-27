/**
 * HCE account-gate arithmetic smoke (no live upstream).
 * Run: node scripts/test-account-gate.mjs
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

/** Resolve extensionless relative imports to .ts for Node's native TS loader. */
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return await nextResolve(specifier + '.ts', context)
      } catch {
        /* fall through */
      }
    }
    return nextResolve(specifier, context)
  }
`), { parentURL: import.meta.url })

async function load(rel) {
  return import(pathToFileURL(path.join(root, rel)).href)
}

async function main() {
  const { AccountGate } = await load('src/main/proxy/accountGate.ts')
  const { resolveAccountRateLimits, shouldMigrateLegacyLooseLimits, PROVIDER_RATE_LIMIT_DEFAULTS } =
    await load('src/main/proxy/rateLimitDefaults.ts')

  const deepseek = resolveAccountRateLimits('deepseek', {})
  assert.equal(deepseek.minIntervalMs, 30_000)
  assert.equal(deepseek.requestsPerHour, 24)
  assert.equal(deepseek.burstCapacity, 5)
  assert.ok(deepseek.requestsPerMinute <= 6)

  assert.equal(
    shouldMigrateLegacyLooseLimits('deepseek', { requestsPerMinute: 24, minIntervalMs: 1500 }),
    true,
  )
  assert.equal(
    shouldMigrateLegacyLooseLimits('deepseek', { requestsPerMinute: 6, minIntervalMs: 30_000 }),
    false,
  )

  const gate = new AccountGate()
  const id = 'acct-hce-1'
  const limits = { ...PROVIDER_RATE_LIMIT_DEFAULTS.deepseek, intervalJitterRatio: 0 }

  assert.equal(gate.tryAcquire(id, limits), true)
  gate.release(id, limits)

  const blocked = gate.check(id, limits)
  assert.equal(blocked.available, false)
  assert.ok(['interval', 'switch_penalty'].includes(blocked.reason))
  assert.ok((blocked.retryAfterMs || 0) > 0)

  const burstId = 'acct-burst'
  const burstLimits = {
    ...limits,
    minIntervalMs: 0,
    requestsPerMinute: 0,
    requestsPerHour: 0,
    burstCapacity: 2,
    burstRefillMs: 60_000,
  }
  assert.equal(gate.tryAcquire(burstId, burstLimits), true)
  gate.release(burstId, burstLimits)
  assert.equal(gate.tryAcquire(burstId, burstLimits), true)
  gate.release(burstId, burstLimits)
  assert.equal(gate.tryAcquire(burstId, burstLimits), false)
  assert.equal(gate.check(burstId, burstLimits).reason, 'burst')

  const sessId = 'acct-sess'
  const sessLimits = { ...limits, sessionCreatesPerHour: 2 }
  assert.equal(gate.checkSessionCreate(sessId, sessLimits).available, true)
  gate.recordSessionCreate(sessId, sessLimits)
  gate.recordSessionCreate(sessId, sessLimits)
  assert.equal(gate.checkSessionCreate(sessId, sessLimits).available, false)
  assert.equal(gate.checkSessionCreate(sessId, sessLimits).reason, 'session_create')

  const switchId = 'acct-switch'
  gate.applySwitchPenalty(switchId, { ...limits, switchPenaltyMs: 60_000 })
  const penalized = gate.check(switchId, { ...limits, minIntervalMs: 0 })
  assert.equal(penalized.available, false)

  const retry = gate.estimateRetryAfterMs([id], () => limits)
  assert.ok(retry >= 1000 && retry <= 60_000)

  console.log('test-account-gate (HCE): ok')
}

main().catch((err) => {
  console.error('test-account-gate: FAIL', err)
  process.exit(1)
})
