/**
 * Kimi web-session token helpers.
 * Access JWT (~15m) is refreshed via auth.kimi.com Connect RPC using localStorage refresh_token.
 */

import axios from 'axios'

const DEFAULT_WEB_ORIGIN = 'https://www.kimi.com'
const DEFAULT_AUTH_HOST = 'https://auth.kimi.com'
/** Refresh when access JWT expires within this many seconds. */
export const KIMI_ACCESS_REFRESH_LEEWAY_SEC = 120
/** Fallback TTL when JWT has no exp claim. */
export const KIMI_ACCESS_FALLBACK_TTL_SEC = 900

export interface KimiTokenPair {
  accessToken: string
  refreshToken: string
  /** Unix seconds */
  expiresAt: number
  userId?: string
}

export interface KimiRefreshResult extends KimiTokenPair {
  rotated: boolean
}

/**
 * Normalize localStorage refresh_token (sometimes a JSON array of segments).
 */
export function normalizeKimiRefreshToken(raw: string | undefined | null): string {
  if (!raw) return ''
  let text = String(raw).trim()
  if (!text) return ''
  // Strip accidental surrounding quotes
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1)
  }
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed.map((part) => String(part)).join('.')
      }
    } catch {
      /* keep original */
    }
  }
  return text
}

/**
 * Decode JWT payload without verifying signature.
 */
export function decodeKimiJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (payload.length % 4)) % 4
    if (pad) payload += '='.repeat(pad)
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Whether the token looks like a Kimi access JWT.
 */
export function isKimiAccessJwt(token: string): boolean {
  if (!token.startsWith('eyJ') || token.split('.').length !== 3) return false
  const payload = decodeKimiJwtPayload(token)
  if (!payload) return false
  if (payload.app_id === 'kimi' && payload.typ === 'access') return true
  // Some builds only set typ
  return payload.typ === 'access'
}

/**
 * Read exp (unix seconds) from access JWT, or undefined.
 */
export function getKimiJwtExpiry(token: string): number | undefined {
  const payload = decodeKimiJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined
}

/**
 * True when access token is usable for at least `leewaySec` more seconds.
 */
export function isKimiAccessFresh(
  accessToken: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  leewaySec: number = KIMI_ACCESS_REFRESH_LEEWAY_SEC,
): boolean {
  if (!accessToken) return false
  const exp = getKimiJwtExpiry(accessToken)
  if (exp === undefined) return false
  return exp > nowSec + leewaySec
}

/**
 * Map web origin to auth gateway host.
 */
export function resolveKimiAuthBase(webOrigin?: string): string {
  const origin = (webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '')
  if (origin.includes('kimi.ai')) return 'https://auth.kimi.ai'
  return DEFAULT_AUTH_HOST
}

/**
 * Refresh web session tokens.
 * POST {auth}/api/account.gateway.v1.AuthService/RefreshToken
 * body: { refresh_token } → { accessToken, refreshToken? } (camelCase)
 */
export async function refreshKimiWebTokens(
  refreshTokenRaw: string,
  options?: { webOrigin?: string; timeoutMs?: number },
): Promise<KimiRefreshResult> {
  const refreshToken = normalizeKimiRefreshToken(refreshTokenRaw)
  if (!refreshToken) {
    throw new Error('Kimi refresh_token is empty')
  }

  const authBase = resolveKimiAuthBase(options?.webOrigin)
  const webOrigin = (options?.webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '')
  const url = `${authBase}/api/account.gateway.v1.AuthService/RefreshToken`

  const response = await axios.post(
    url,
    { refresh_token: refreshToken },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: webOrigin,
        Referer: `${webOrigin}/`,
        'Connect-Protocol-Version': '1',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      timeout: options?.timeoutMs ?? 20_000,
      validateStatus: () => true,
    },
  )

  if (response.status === 401 || response.status === 403) {
    throw new Error('Kimi refresh_token rejected (session expired); re-login and paste a fresh refresh_token')
  }
  if (response.status !== 200 || !response.data) {
    const detail =
      response.data?.message ||
      response.data?.code ||
      response.data?.error_type ||
      `HTTP ${response.status}`
    throw new Error(`Kimi token refresh failed: ${detail}`)
  }

  const data = response.data as Record<string, unknown>
  const accessToken = String(data.accessToken || data.access_token || '')
  const nextRefresh = normalizeKimiRefreshToken(
    String(data.refreshToken || data.refresh_token || refreshToken),
  )
  if (!accessToken) {
    throw new Error('Kimi token refresh returned empty accessToken')
  }

  const expiresAt =
    getKimiJwtExpiry(accessToken) ?? Math.floor(Date.now() / 1000) + KIMI_ACCESS_FALLBACK_TTL_SEC
  const userId = (decodeKimiJwtPayload(accessToken)?.sub as string | undefined) || undefined

  return {
    accessToken,
    refreshToken: nextRefresh || refreshToken,
    expiresAt,
    userId,
    rotated: Boolean(nextRefresh && nextRefresh !== refreshToken),
  }
}

/**
 * Pick refresh + optional access from account credential bag.
 */
export function pickKimiCredentials(credentials: Record<string, string> | undefined): {
  accessToken: string
  refreshToken: string
} {
  const creds = credentials || {}
  const accessCandidate =
    creds.token || creds.accessToken || creds.access_token || creds['kimi-auth'] || ''
  const refreshCandidate =
    normalizeKimiRefreshToken(creds.refresh_token || creds.refreshToken) ||
    (!isKimiAccessJwt(accessCandidate) ? normalizeKimiRefreshToken(accessCandidate) : '')

  const accessToken = isKimiAccessJwt(accessCandidate) ? accessCandidate : ''
  return { accessToken, refreshToken: refreshCandidate }
}
