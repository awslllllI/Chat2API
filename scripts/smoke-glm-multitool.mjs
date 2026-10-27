/**
 * Low-frequency GLM multi-tool stream smoke (write preferred; no DeepSeek).
 * Usage: node scripts/smoke-glm-multitool.mjs
 */
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8082').replace(/\/$/, '')
const model = process.env.CHAT2API_MODEL || 'GLM-5.1'
const gapMs = Number(process.env.SMOKE_INTERVAL_MS || 15000)

const tools = [
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          contents: { type: 'string' },
        },
        required: ['path', 'contents'],
      },
    },
  },
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
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a URL in a browser',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
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
    if (!res.ok) throw new Error(`http ${res.status}: ${text.slice(0, 400)}`)
    return text
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

function collectToolCalls(sseText) {
  const byIndex = new Map()
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = chunk?.choices?.[0]?.delta
    if (!delta?.tool_calls) continue
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0
      const prev = byIndex.get(idx) || { id: '', name: '', arguments: '' }
      if (tc.id) prev.id = tc.id
      if (tc.function?.name) prev.name += tc.function.name
      if (tc.function?.arguments) prev.arguments += tc.function.arguments
      byIndex.set(idx, prev)
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}

async function main() {
  console.log(`glm multitool smoke model=${model} gap=${gapMs}ms`)
  await sleep(gapMs)

  const text = await chat({
    model,
    stream: true,
    tools,
    tool_choice: 'required',
    messages: [
      {
        role: 'user',
        content:
          'Do NOT call open_url. Call write exactly once with path=task_stats.py and contents=print(1). Tool call only, no prose.',
      },
    ],
  })

  assertNoLeak(text)
  const calls = collectToolCalls(text)
  console.log('[stream] tool_calls', calls)
  if (calls.length === 0) throw new Error('no tool_calls')
  if (calls[0].name !== 'write') throw new Error(`expected write, got ${calls[0].name}`)
  const args = JSON.parse(calls[0].arguments || '{}')
  if (!args.path || !args.contents) throw new Error(`missing write args: ${JSON.stringify(args)}`)
  console.log('smoke-glm-multitool: PASS', args)
}

main().catch((err) => {
  console.error('smoke-glm-multitool: FAIL', err.message || err)
  process.exit(1)
})
