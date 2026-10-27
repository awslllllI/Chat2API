/**
 * Low-frequency GLM tool-calling smoke. Honors Retry-After. Avoids DeepSeek.
 * Usage: node scripts/smoke-glm-tools.mjs
 */
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8082').replace(/\/$/, '')
const model = process.env.CHAT2API_MODEL || 'GLM-5.1'
const gapMs = Number(process.env.SMOKE_INTERVAL_MS || 15000)

const tools = [
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'Run PowerShell',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command', 'description'],
      },
    },
  },
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function chat(body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status === 429) {
      let wait = gapMs
      try {
        const j = JSON.parse(text)
        wait = Math.max(wait, Number(j?.error?.retry_after || 0) * 1000 + 1000)
      } catch {
        /* ignore */
      }
      console.log(`429, waiting ${wait}ms then retry`)
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`http ${res.status}: ${text.slice(0, 300)}`)
    return { res, text }
  }
  throw new Error('exhausted 429 retries')
}

function assertNoLeak(raw) {
  if (/DSML/i.test(raw) || /end of sentence/i.test(raw)) {
    throw new Error('leaked control tokens')
  }
  if (/(?<![</])\|CHAT2API\|/.test(raw) || (/<\|CHAT2API\|/.test(raw) && !/"tool_calls"/.test(raw))) {
    throw new Error('leaked Chat2API markup')
  }
  if (/\[function_calls\]/.test(raw) && !/"tool_calls"/.test(raw)) {
    throw new Error('leaked bracket markup')
  }
}

async function main() {
  console.log(`glm smoke model=${model} gap=${gapMs}ms`)

  const non = await chat({
    model,
    stream: false,
    tools,
    tool_choice: 'required',
    messages: [
      {
        role: 'user',
        content: 'Call pwsh once. command must be Get-Date. Include description. Tool call only.',
      },
    ],
  })
  const nonJson = JSON.parse(non.text)
  assertNoLeak(non.text)
  const args = JSON.parse(nonJson.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments || '{}')
  console.log('[nonstream]', nonJson.choices?.[0]?.finish_reason, args)
  if (!args.command || !args.description) throw new Error('missing required args')

  await sleep(gapMs)

  const stream = await chat({
    model,
    stream: true,
    tools,
    tool_choice: 'required',
    messages: [
      {
        role: 'user',
        content: 'Call pwsh once. command must be echo glm-ok. Include description. Tool call only.',
      },
    ],
  })
  assertNoLeak(stream.text)
  if (!/tool_calls/.test(stream.text)) throw new Error('stream missing tool_calls')
  console.log('[stream] ok bytes=', stream.text.length)
  console.log('smoke-glm-tools: PASS')
}

main().catch((err) => {
  console.error('smoke-glm-tools: FAIL', err.message || err)
  process.exit(1)
})
