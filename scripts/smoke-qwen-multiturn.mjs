/**
 * Qwen multi-turn tool stream smoke: finish_reason, array args, no nested argument, no leak.
 * HCE: ALLOW_LIVE_UPSTREAM=1; SMOKE_INTERVAL_MS >= 30000.
 */
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8082').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_API_KEY || ''
const model = process.env.CHAT2API_MODEL || 'Qwen3.5-Flash'
const gapMs = Number(process.env.SMOKE_INTERVAL_MS || 35_000)
const HCE_MIN = 30_000

if (process.env.ALLOW_LIVE_UPSTREAM !== '1') {
  console.error('refused: set ALLOW_LIVE_UPSTREAM=1')
  process.exit(2)
}
if (!Number.isFinite(gapMs) || gapMs < HCE_MIN) {
  console.error(`SMOKE_INTERVAL_MS must be >= ${HCE_MIN}`)
  process.exit(2)
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Update todos',
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
                id: { type: 'string' },
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
      description: 'Write file',
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

/** Sleep helper. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Build auth headers. */
function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

/** Fail if protocol crumbs leak into client-visible text. */
function assertNoLeak(s, label) {
  const text = String(s || '')
  for (const bad of ['CHAT2API|', '2API|tool', '2API|parameter', '<|CHAT2API|']) {
    if (text.includes(bad)) throw new Error(`${label}: protocol leak contains ${bad}`)
  }
}

/**
 * Stream one chat completion; wait/retry on 429 within HCE envelope.
 */
async function streamChat(messages, label) {
  for (let round = 0; round < 6; round += 1) {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model,
        stream: true,
        tools,
        tool_choice: 'auto',
        temperature: 0,
        messages,
      }),
    })
    if (res.status === 429) {
      const waitSec = Math.min(Math.max(Number(res.headers.get('retry-after') || 30), 30), 90)
      console.warn(`[${label}] 429 round=${round + 1}; wait ${waitSec}s`)
      await sleep(waitSec * 1000)
      continue
    }
    if (!res.ok || !res.body) {
      const text = await res.text()
      throw new Error(`${label} status ${res.status} ${text.slice(0, 300)}`)
    }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let content = ''
    let finish = null
    const byIndex = {}

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
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
            if (choice?.finish_reason) finish = choice.finish_reason
            const delta = choice?.delta || {}
            if (typeof delta.content === 'string') content += delta.content
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0
                if (!byIndex[i]) byIndex[i] = { name: '', args: '' }
                if (tc.function?.name) byIndex[i].name += tc.function.name
                if (tc.function?.arguments) byIndex[i].args += tc.function.arguments
              }
            }
          } catch {
            /* ignore partial JSON */
          }
        }
      }
    }

    const toolCalls = Object.values(byIndex).map((t) => {
      let args = {}
      try {
        args = JSON.parse(t.args || '{}')
      } catch {
        args = { __raw: t.args }
      }
      return { name: t.name, args }
    })
    return { finish, content, toolCalls }
  }
  throw new Error(`${label}: exhausted 429 waits`)
}

async function main() {
  console.log(`qwen multiturn model=${model} gap=${gapMs}ms`)
  const msgs = [
    {
      role: 'user',
      content:
        'Call todo_write once with todos array of one item: content=smoke-a status=pending id=1. Tool only.',
    },
  ]

  console.log('step1 todo_write')
  let r = await streamChat(msgs, 's1')
  assertNoLeak(r.content, 's1 content')
  assertNoLeak(JSON.stringify(r.toolCalls), 's1 tools')
  if (!r.finish) throw new Error('missing finish_reason s1')
  console.log('s1', r.finish, JSON.stringify(r.toolCalls).slice(0, 240))
  if (!r.toolCalls.length) throw new Error('no tool call s1')
  const tc = r.toolCalls[0]
  if (tc.name === 'todo_write' && !Array.isArray(tc.args.todos)) {
    throw new Error(`todos not array: ${JSON.stringify(tc.args).slice(0, 200)}`)
  }
  if (tc.args && Object.prototype.hasOwnProperty.call(tc.args, 'argument')) {
    throw new Error(`nested argument wrapper: ${JSON.stringify(tc.args).slice(0, 200)}`)
  }

  msgs.push({
    role: 'assistant',
    content: r.content || null,
    tool_calls: r.toolCalls.map((t, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    })),
  })
  msgs.push({ role: 'tool', tool_call_id: 'call_0', content: JSON.stringify({ ok: true }) })
  msgs.push({
    role: 'user',
    content: 'Now call write once: file_path=D:/tmp/qwen-smoke.txt content=hello-qwen. Tool only.',
  })

  await sleep(gapMs)
  console.log('step2 write')
  r = await streamChat(msgs, 's2')
  assertNoLeak(r.content, 's2 content')
  assertNoLeak(JSON.stringify(r.toolCalls), 's2 tools')
  if (!r.finish) throw new Error('missing finish_reason s2')
  console.log('s2', r.finish, JSON.stringify(r.toolCalls).slice(0, 240))
  const w = r.toolCalls.find((t) => t.name === 'write') || r.toolCalls[0]
  if (!w) throw new Error('no tool s2')
  if (w.name === 'write') {
    if (typeof w.args.content !== 'string' || !w.args.content) {
      throw new Error(`write missing content ${JSON.stringify(w.args).slice(0, 200)}`)
    }
    if (Object.prototype.hasOwnProperty.call(w.args, 'argument')) {
      throw new Error('nested argument wrapper on write')
    }
  }
  console.log('smoke-qwen-multiturn: PASS')
}

main().catch((err) => {
  console.error('smoke-qwen-multiturn: FAIL', err.message || err)
  process.exit(1)
})
