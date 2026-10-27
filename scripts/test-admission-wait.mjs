/**
 * Admission-wait + gate interaction smoke (no live upstream).
 * Run: node scripts/test-admission-wait.mjs
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

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
  const { shouldAdmissionWait, tryAcquireWithAdmissionWait, sleepMs } = await load(
    'src/main/proxy/admissionWait.ts',
  )

  assert.equal(shouldAdmissionWait(20_000, 60_000), true)
  assert.equal(shouldAdmissionWait(90_000, 60_000), false)
  assert.equal(shouldAdmissionWait(0, 60_000), false)

  const gate = new AccountGate()
  // Patch module singleton by using tryAcquireWithAdmissionWait's imported accountGate —
  // instead drive interval via the same AccountGate class through tryAcquireWithAdmissionWait
  // by temporarily replacing behavior: use short limits and the real accountGate export.

  const { accountGate } = await load('src/main/proxy/accountGate.ts')
  const id = 'acct-admit-1'
  accountGate.reset(id)

  const limits = {
    requestsPerMinute: 0,
    minIntervalMs: 80,
    maxConcurrency: 1,
    requestsPerHour: 0,
    dailyLimit: 0,
    burstCapacity: 0,
    burstRefillMs: 0,
    stickyTtlMs: 0,
    sessionCreatesPerHour: 0,
    switchPenaltyMs: 0,
    intervalJitterRatio: 0,
    retryAfterCapMs: 5_000,
  }

  assert.equal(accountGate.tryAcquire(id, limits), true)
  accountGate.release(id, limits)

  const started = Date.now()
  const result = await tryAcquireWithAdmissionWait(id, limits, 5_000)
  const elapsed = Date.now() - started

  assert.equal(result.acquired, true)
  assert.ok(result.waitedMs >= 50, `expected wait, got ${result.waitedMs}`)
  assert.ok(elapsed >= 50, `elapsed ${elapsed}`)

  // Cap too small → no wait, fail fast
  accountGate.release(id, limits)
  const failFast = await tryAcquireWithAdmissionWait(id, { ...limits, minIntervalMs: 30_000 }, 10)
  assert.equal(failFast.acquired, false)
  assert.equal(failFast.waitedMs, 0)

  await sleepMs(1)
  void gate
  console.log('test-admission-wait: ok')
}

main().catch((err) => {
  console.error('test-admission-wait: FAIL', err)
  process.exit(1)
})
