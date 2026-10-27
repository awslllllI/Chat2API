/**
 * Live DeepSeek tool-calling smoke via local Chat2API proxy.
 * Human Envelope: refuses live upstream unless ALLOW_LIVE_UPSTREAM=1 and
 * SMOKE_INTERVAL_MS >= 30000 (DeepSeek HCE min interval).
 *
 * Usage:
 *   ALLOW_LIVE_UPSTREAM=1 SMOKE_INTERVAL_MS=35000 node scripts/smoke-deepseek-tools.mjs
 * Optional env JSON: %TEMP%/chat2api-smoke-env.json { baseUrl, apiKey }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const envPath = path.join(os.tmpdir(), 'chat2api-smoke-env.json')
const env = fs.existsSync(envPath)
  ? JSON.parse(fs.readFileSync(envPath, 'utf8'))
  : { baseUrl: 'http://127.0.0.1:8082' }

const baseUrl = (process.env.CHAT2API_BASE_URL || env.baseUrl || 'http://127.0.0.1:8082').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_API_KEY || env.apiKey || ''
const intervalMs = Number(process.env.SMOKE_INTERVAL_MS || 35_000)
const model = process.env.CHAT2API_MODEL || env.model || 'deepseek-v4-flash'
const HCE_MIN_INTERVAL_MS = 30_000

if (process.env.ALLOW_LIVE_UPSTREAM !== '1') {
  console.error(
    'smoke-deepseek-tools: refused. Set ALLOW_LIVE_UPSTREAM=1 to hit real accounts (HCE anti-ban).',
  )
  process.exit(2)
}
if (!Number.isFinite(intervalMs) || intervalMs < HCE_MIN_INTERVAL_MS) {
  console.error(
    `smoke-deepseek-tools: SMOKE_INTERVAL_MS must be >= ${HCE_MIN_INTERVAL_MS} (got ${intervalMs}).`,
  )
  process.exit(2)
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'Run a PowerShell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          description: { type: 'string', description: 'Short description of what the command does' },
          working_directory: { type: 'string' },
        },
        required: ['command', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'working_directory',
      description: 'Get or set working directory',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function chat(body) {
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`non-json ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!res.ok) {
    throw new Error(`http ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return json
}

function assertNoLeak(payload) {
  const raw = JSON.stringify(payload)
  const leaks = []
  if (/DSML/i.test(raw)) leaks.push('DSML')
  if (/end of sentence/i.test(raw)) leaks.push('end of sentence')
  // Broken open tag: |CHAT2API| not preceded by '<' or '/' (close tags are </|CHAT2API|...>)
  if (/(?<![</])\|CHAT2API\|/.test(raw)) leaks.push('broken CHAT2API')
  if (/rawText/.test(raw)) leaks.push('rawText')
  if (leaks.length) {
    throw new Error(`response leaked markers: ${leaks.join(', ')}`)
  }
}

function summarize(label, result) {
  const msg = result?.choices?.[0]?.message || {}
  const toolCalls = msg.tool_calls || []
  const content = typeof msg.content === 'string' ? msg.content : ''
  console.log(`[${label}] finish=${result?.choices?.[0]?.finish_reason} tools=${toolCalls.length} contentLen=${content.length}`)
  for (const tc of toolCalls) {
    let args = {}
    try {
      args = JSON.parse(tc.function?.arguments || '{}')
    } catch {
      args = { _raw: tc.function?.arguments }
    }
    console.log(`  -> ${tc.function?.name} keys=${Object.keys(args).join(',')}`)
  }
  return { msg, toolCalls, content }
}

async function main() {
  console.log(`smoke against ${baseUrl} model=${model} interval=${intervalMs}ms`)

  // 1) Force a tool call with required description
  const r1 = await chat({
    model,
    stream: false,
    tools,
    tool_choice: 'required',
    messages: [
      {
        role: 'user',
        content:
          'Call tool pwsh exactly once. command must be Get-Date. Include every required argument. Reply with tool call only.',
      },
    ],
  })
  assertNoLeak(r1)
  const s1 = summarize('pwsh', r1)
  if (s1.toolCalls.length === 0) {
    throw new Error('expected tool_calls for pwsh')
  }
  const pwsh = s1.toolCalls.find((t) => t.function?.name === 'pwsh') || s1.toolCalls[0]
  const args1 = JSON.parse(pwsh.function.arguments || '{}')
  if (!args1.command) throw new Error('pwsh missing command')
  if (!args1.description) throw new Error('pwsh missing description (required-arg fill failed)')

  await sleep(intervalMs)

  // 2) working_directory tool
  const r2 = await chat({
    model,
    stream: false,
    tools,
    tool_choice: { type: 'function', function: { name: 'working_directory' } },
    messages: [
      {
        role: 'user',
        content: 'Call working_directory with path D:/tmp exactly once. Tool call only.',
      },
    ],
  })
  assertNoLeak(r2)
  const s2 = summarize('cwd', r2)
  if (s2.toolCalls.length === 0) throw new Error('expected working_directory tool_calls')

  await sleep(intervalMs)

  // 3) streaming path
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      tools,
      tool_choice: 'required',
      messages: [
        {
          role: 'user',
          content: 'Call pwsh with command echo smoke-ok. Include required args. Tool call only.',
        },
      ],
    }),
  })
  if (!streamRes.ok) {
    throw new Error(`stream http ${streamRes.status}: ${(await streamRes.text()).slice(0, 300)}`)
  }
  const streamText = await streamRes.text()
  if (/DSML/i.test(streamText) || /end of sentence/i.test(streamText)) {
    throw new Error('stream leaked DSML or end-of-sentence tokens')
  }
  if (/(?<![</])\|CHAT2API\|/.test(streamText) || /<\|CHAT2API\|/.test(streamText)) {
    // Well-formed markup must have been converted to tool_calls, not left as content.
    if (!/"tool_calls"/.test(streamText)) {
      throw new Error('stream leaked Chat2API markup as content')
    }
  }
  if (!/tool_calls/.test(streamText)) {
    console.log('[stream] warn: no tool_calls (model may have emitted unparsable markup); no protocol leak')
  } else {
    console.log('[stream] ok, bytes=', streamText.length)
  }

  console.log('smoke-deepseek-tools: PASS')
}

main().catch((err) => {
  console.error('smoke-deepseek-tools: FAIL', err.message || err)
  process.exit(1)
})
