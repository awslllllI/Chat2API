/**
 * Offline unit checks for Kimi web token helpers.
 */
const { pathToFileURL } = await import('node:url')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'src/main/proxy/adapters/kimi-auth.ts')).href)

const {
  normalizeKimiRefreshToken,
  isKimiAccessJwt,
  isKimiAccessFresh,
  pickKimiCredentials,
  resolveKimiAuthBase,
  getKimiJwtExpiry,
} = mod

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(normalizeKimiRefreshToken('["a","b","c"]') === 'a.b.c', 'array refresh normalize')
assert(normalizeKimiRefreshToken('"abc"') === 'abc', 'quoted refresh normalize')
assert(resolveKimiAuthBase('https://www.kimi.ai') === 'https://auth.kimi.ai', 'auth host .ai')
assert(resolveKimiAuthBase('https://www.kimi.com') === 'https://auth.kimi.com', 'auth host .com')

// Synthetic access JWT (header.payload.sig) with typ=access, app_id=kimi, exp far future
const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url')
const payload = Buffer.from(
  JSON.stringify({
    app_id: 'kimi',
    typ: 'access',
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString('base64url')
const access = `${header}.${payload}.sig`
assert(isKimiAccessJwt(access), 'detect access jwt')
assert(isKimiAccessFresh(access), 'fresh access')
assert(typeof getKimiJwtExpiry(access) === 'number', 'exp parsed')

const picked = pickKimiCredentials({ token: access, refresh_token: '["r1","r2"]' })
assert(picked.accessToken === access, 'pick access')
assert(picked.refreshToken === 'r1.r2', 'pick refresh normalized')

const onlyRefresh = pickKimiCredentials({ token: 'plain-refresh-token' })
assert(!onlyRefresh.accessToken, 'non-jwt token is not access')
assert(onlyRefresh.refreshToken === 'plain-refresh-token', 'non-jwt token treated as refresh')

console.log('test-kimi-auth: ok')
