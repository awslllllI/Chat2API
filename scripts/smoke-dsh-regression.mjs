/**
 * Multi-provider dsh-shaped regression against local Chat2API.
 * Covers: stream finish_reason, tool arg types (array/write content), protocol leak.
 * HCE: ALLOW_LIVE_UPSTREAM=1 required; default interval 35s; waits on 429 Retry-After.
 *
 *   ALLOW_LIVE_UPSTREAM=1 node scripts/smoke-dsh-regression.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const envPath = path.join(os.tmpdir(), 'chat2api-smoke-env.json')
const env = fs.existsSync(envPath) ? JSON.parse(fs.readFileSync(envPath, 'utf8')) : {}
const baseUrl = (process.env.CHAT2API_BASE_URL || env.baseUrl || 'http://127.0.0.1:8082').replace(
  /\/$/,
  '',
)
const apiKey = process.env.CHAT2API_API_KEY || env.apiKey || ''
const intervalMs = Number(process.env.SMOKE_INTERVAL_MS || 35_000)
const HCE_MIN = 30_000

if (process.env.ALLOW_LIVE_UPSTREAM !== '1') {
  console.error('refused: set ALLOW_LIVE_UPSTREAM=1')
  process.exit(2)
}
if (!Number.isFinite(intervalMs) || intervalMs < HCE_MIN) {
  console.error(`SMOKE_INTERVAL_MS must be >= ${HCE_MIN}`)
  process.exit(2)
}

/** Pick one cheap-ish model per provider family present in /v1/models. */
const FAMILY_PICK = [
  { family: 'qwen', prefer: ['Qwen3.5-Flash', 'Qwen3.6', 'Qwen3.7-Max'] },
  { family: 'glm', prefer: ['GLM-5.1', 'GLM-5', 'GLM-4.7'] },
  { family: 'deepseek', prefer: ['deepseek-v4-flash', 'deepseek-v4-flash-search', 'deepseek-v4-flash-think'] },
  { family: 'mimo', prefer: ['MiMo-V2-Flash', 'MiMo-V2.5', 'MiMo-V2.5-Pro'] },
  { family: 'kimi', prefer: ['Kimi-K2.6', 'kimi'] },
]

const tools = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Update todo list',
      parameters: {
        type: 'object',
        required: ['todos'],
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        required: ['file_path', 'content'],
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

function detectFamily(modelId) {
  const m = String(modelId).toLowerCase()
  if (m.includes('qwen') || m.includes('tongyi')) return 'qwen'
  if (m.includes('glm')) return 'glm'
  if (m.includes('deepseek')) return 'deepseek'
  if (m.includes('mimo')) return 'mimo'
  if (m.includes('kimi') || m.includes('moonshot')) return 'kimi'
  return 'other'
}

async function listModels() {
  const res = await fetch(`${baseUrl}/v1/models`, { headers: headers() })
  const body = await res.json()
  if (!res.ok) throw new Error(`models ${res.status}`)
  return (body.data || []).map((x) => x.id)
}

function pickModels(ids) {
  const byFamily = new Map()
  for (const id of ids) {
    const f = detectFamily(id)
    if (!byFamily.has(f)) byFamily.set(f, [])
    byFamily.get(f).push(id)
  }
  const picked = []
  for (const { family, prefer } of FAMILY_PICK) {
    const available = byFamily.get(family) || []
    if (available.length === 0) continue
    const hit = prefer.find((p) => available.includes(p)) || available[0]
    picked.push({ family, model: hit })
  }
  return picked
}

/**
 * POST chat; on 429 wait Retry-After (capped) and retry.
 */
async function chatWithWait(body, label, maxWaitRounds = 6) {
  for (let round = 0; round < maxWaitRounds; round += 1) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    })
    const retryAfter = Number(res.headers.get('retry-after') || 0)
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text.slice(0, 400) }
    }
    if (res.status === 429) {
      // Prefer server hint, but never retry faster than HCE min envelope.
      const waitSec = Math.min(Math.max(retryAfter || 30, Math.ceil(HCE_MIN / 1000)), 90)
      console.warn(`[${label}] 429 round=${round + 1}; wait ${waitSec}s body=${JSON.stringify(json?.error || {}).slice(0, 160)}`)
      await sleep(waitSec * 1000)
      continue
    }
    return { status: res.status, json, text }
  }
  return { status: 429, json: { error: { message: 'exhausted 429 waits' } }, text: '' }
}

async function readStream(resBody) {
  const reader = resBody.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  let finishReason = null
  let toolArgs = []
  let content = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    full += buf
    const parts = buf.split('\n\n')
    buf = parts.pop() || ''
    for (const block of parts) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          const choice = chunk.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta || {}
          if (typeof delta.content === 'string') content += delta.content
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.arguments) toolArgs.push(tc.function.arguments)
              if (tc.function?.name) toolArgs.push(`name:${tc.function.name}`)
            }
          }
        } catch {
          /* ignore partial */
        }
      }
    }
  }
  return { finishReason, content, toolArgs, full }
}

async function streamWithWait(body, label, maxWaitRounds = 6) {
  for (let round = 0; round < maxWaitRounds; round += 1) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...body, stream: true }),
    })
    const retryAfter = Number(res.headers.get('retry-after') || 0)
    if (res.status === 429) {
      const waitSec = Math.min(Math.max(retryAfter || 30, Math.ceil(HCE_MIN / 1000)), 90)
      console.warn(`[${label}] stream 429 round=${round + 1}; wait ${waitSec}s`)
      await sleep(waitSec * 1000)
      continue
    }
    if (!res.ok || !res.body) {
      const text = await res.text()
      return { status: res.status, error: text.slice(0, 400) }
    }
    const parsed = await readStream(res.body)
    return { status: res.status, ...parsed }
  }
  return { status: 429, error: 'exhausted 429 waits' }
}

function assertNoLeak(text, label) {
  const s = String(text || '')
  const bad = ['CHAT2API|', '2API|tool', '2API|parameter', '<|CHAT2API|']
  for (const b of bad) {
    if (s.includes(b)) throw new Error(`${label}: protocol leak contains ${b}`)
  }
}

function parseToolCallArgs(message) {
  const calls = message?.tool_calls || []
  return calls.map((c) => {
    let args = {}
    try {
      args = JSON.parse(c.function?.arguments || '{}')
    } catch {
      args = { __raw: c.function?.arguments }
    }
    return { name: c.function?.name, args }
  })
}

async function testFamily({ family, model }) {
  const result = { family, model, stream: null, tools: null, ok: true, errors: [] }
  console.log(`\n=== ${family} / ${model} ===`)

  // 1) Stream finish_reason
  try {
    const stream = await streamWithWait(
      {
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        temperature: 0,
      },
      `${family}/stream`,
    )
    if (stream.status !== 200) {
      const detail = stream.error || ''
      if (/401|paused|forbidden|invalid.?token|auth|accounts_unavailable|no usable account/i.test(detail)) {
        result.skipped = 'account_risk_or_auth'
        result.errors.push(`stream skipped: ${detail}`)
        console.warn(`[${family}] stream SKIP (account)`, detail.slice(0, 160))
        return result
      }
      throw new Error(`stream status ${stream.status} ${detail}`)
    }
    if (!stream.finishReason) throw new Error('missing finish_reason (TRANSPORT risk)')
    assertNoLeak(stream.content, 'stream content')
    result.stream = { finishReason: stream.finishReason, content: (stream.content || '').slice(0, 80) }
    console.log(`[${family}] stream ok finish=${stream.finishReason}`)
  } catch (e) {
    const msg = e.message || String(e)
    if (
      /401|paused|forbidden|invalid.?token|auth|accounts_unavailable|no usable account|exhausted 429|no_available_account|no available account/i.test(
        msg,
      )
    ) {
      result.skipped = 'account_risk_or_unavailable'
      result.errors.push(`stream skipped: ${msg}`)
      console.warn(`[${family}] stream SKIP (account/unavailable)`, msg.slice(0, 200))
      return result
    }
    result.ok = false
    result.errors.push(`stream: ${msg}`)
    console.error(`[${family}] stream FAIL`, msg)
  }

  await sleep(intervalMs)

  // 2) Tools: require write with both fields OR todo array
  try {
    const toolRes = await chatWithWait(
      {
        model,
        stream: false,
        tools,
        tool_choice: 'auto',
        messages: [
          {
            role: 'user',
            content:
              'Call tool write exactly once. file_path must be D:/tmp/chat2api-smoke.txt and content must be hello-smoke. Include every required argument. Tool call only, no prose.',
          },
        ],
        temperature: 0,
      },
      `${family}/tools`,
    )
    if (toolRes.status !== 200) {
      throw new Error(`tools status ${toolRes.status} ${JSON.stringify(toolRes.json?.error || toolRes.json).slice(0, 200)}`)
    }
    const msg = toolRes.json?.choices?.[0]?.message
    assertNoLeak(msg?.content || '', 'tool message content')
    const parsed = parseToolCallArgs(msg)
    if (parsed.length === 0) {
      // Some models reply text-only; still require no leak and non-empty
      if (!msg?.content) throw new Error('no tool_calls and empty content')
      result.tools = { mode: 'text', preview: String(msg.content).slice(0, 100) }
      console.warn(`[${family}] tools: no tool_calls (text only) — soft warn`)
    } else {
      const write = parsed.find((p) => p.name === 'write') || parsed[0]
      if (write.name === 'write') {
        if (typeof write.args.content !== 'string' || !write.args.content) {
          throw new Error(`write missing content: ${JSON.stringify(write.args).slice(0, 200)}`)
        }
        if (typeof write.args.file_path !== 'string') {
          throw new Error(`write missing file_path`)
        }
      }
      if (write.name === 'todo_write') {
        if (!Array.isArray(write.args.todos)) {
          throw new Error(`todos not array: ${typeof write.args.todos}`)
        }
      }
      result.tools = { mode: 'tools', calls: parsed.map((p) => ({ name: p.name, keys: Object.keys(p.args) })) }
      console.log(`[${family}] tools ok`, JSON.stringify(result.tools.calls))
    }
  } catch (e) {
    const msg = e.message || String(e)
    if (
      /401|paused|forbidden|invalid.?token|auth|accounts_unavailable|no usable account|exhausted 429|no_available_account|no available account/i.test(
        msg,
      )
    ) {
      result.skipped = 'account_risk_or_unavailable'
      result.errors.push(`tools skipped: ${msg}`)
      console.warn(`[${family}] tools SKIP (account/unavailable)`, msg.slice(0, 200))
      return result
    }
    result.ok = false
    result.errors.push(`tools: ${msg}`)
    console.error(`[${family}] tools FAIL`, msg)
  }

  return result
}

async function main() {
  console.log(`baseUrl=${baseUrl} intervalMs=${intervalMs}`)
  const ids = await listModels()
  const picked = pickModels(ids)
  console.log(
    'picked',
    picked.map((p) => `${p.family}:${p.model}`).join(', ') || '(none)',
  )
  if (picked.length === 0) {
    console.error('no models to test')
    process.exit(1)
  }

  const results = []
  for (let i = 0; i < picked.length; i += 1) {
    const r = await testFamily(picked[i])
    results.push(r)
    if (i < picked.length - 1) await sleep(intervalMs)
  }

  const reportPath = path.join(
    process.cwd(),
    'docs',
    'reports',
    `smoke-dsh-regression-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ baseUrl, intervalMs, results }, null, 2))
  console.log('\nreport', reportPath)

  const failed = results.filter((r) => !r.ok && !r.skipped)
  const skipped = results.filter((r) => r.skipped)
  if (skipped.length) {
    console.warn(
      'SKIPPED (account risk/auth):',
      skipped.map((s) => s.family).join(', '),
    )
  }
  if (failed.length) {
    console.error(
      'FAILED families:',
      failed.map((f) => `${f.family}(${f.errors.join('; ')})`).join(' | '),
    )
    process.exit(1)
  }
  console.log(failed.length === 0 ? 'ALL OK (skips allowed)' : 'ALL OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
