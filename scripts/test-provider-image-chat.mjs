/**
 * 通过本机代理对有账号的供应商发送真实图片提问，等待上传解析+回复。
 *
 *   ALLOW_LIVE_UPSTREAM=1 node scripts/test-provider-image-chat.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.env.ALLOW_LIVE_UPSTREAM !== '1') {
  console.error('拒绝执行：请设置 ALLOW_LIVE_UPSTREAM=1')
  process.exit(2)
}

const envPath = path.join(os.tmpdir(), 'chat2api-smoke-env.json')
const env = fs.existsSync(envPath) ? JSON.parse(fs.readFileSync(envPath, 'utf8')) : {}
const baseUrl = (process.env.CHAT2API_BASE_URL || env.baseUrl || 'http://127.0.0.1:8082').replace(
  /\/$/,
  '',
)
const apiKey = process.env.CHAT2API_API_KEY || env.apiKey || ''

const PHOTO =
  process.env.TEST_PHOTO ||
  path.join(os.homedir(), 'Pictures', 'iOS', 'IMG_0048.PNG')

if (!fs.existsSync(PHOTO)) {
  console.error('找不到测试照片:', PHOTO)
  process.exit(1)
}

const photoBuf = fs.readFileSync(PHOTO)
const photoMime = PHOTO.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
const dataUrl = `data:${photoMime};base64,${photoBuf.toString('base64')}`
console.log(`测试照片: ${PHOTO} (${photoBuf.length} 字节)`)
console.log(`代理: ${baseUrl}`)

const CASES = [
  { provider: 'Kimi', model: 'Kimi-K2.6' },
  { provider: 'MiniMax', model: 'MiniMax-M2.7' },
  { provider: 'Qwen', model: 'Qwen3-Max' },
  { provider: 'GLM', model: 'GLM-5.1' },
  { provider: 'MiMo', model: 'MiMo-V2-Flash' },
]

async function waitProxy(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      })
      if (res.ok || res.status === 401) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`等待代理超时: ${baseUrl}`)
}

async function chatWithImage(model) {
  const t0 = Date.now()
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '用一句话描述这张图片里有什么。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  const content =
    json?.choices?.[0]?.message?.content ||
    json?.error?.message ||
    json?.message ||
    text.slice(0, 200)
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - t0,
    preview: String(content).replace(/\s+/g, ' ').slice(0, 160),
  }
}

await waitProxy()
const results = []
for (const c of CASES) {
  console.log(`\n======== ${c.provider} / ${c.model} ========`)
  try {
    const r = await chatWithImage(c.model)
    const pass = r.ok && r.ms >= 1500
    console.log(
      `${pass ? '✓' : r.ok ? '△' : '✗'} HTTP ${r.status} ${r.ms}ms — ${r.preview}`,
    )
    if (r.ok && r.ms < 1500) {
      console.warn('警告: 耗时过短，可能未走上传解析')
    }
    results.push({ ...c, ...r, pass: r.ok })
  } catch (e) {
    console.log(`✗ ${e.message || e}`)
    results.push({ ...c, ok: false, pass: false, preview: String(e.message || e), ms: 0 })
  }
  // 供应商间隔，降低风控
  await new Promise((r) => setTimeout(r, 5000))
}

const out = path.join(process.cwd(), 'tmp', 'upload-image-chat-e2e.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ photo: PHOTO, baseUrl, results, at: new Date().toISOString() }, null, 2))
console.log('\n======== 汇总 ========')
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.provider}: ${r.preview}`)
}
console.log('结果已写入', out)
process.exit(results.some((r) => !r.pass) ? 1 : 0)
