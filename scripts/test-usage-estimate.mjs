/**
 * Smoke test for usage estimation and SSE usage injection.
 */
import {
  estimatePromptTokens,
  estimateTextTokens,
  isPlaceholderUsage,
  ensureCompletionUsage,
  createUsageInjectTransform,
} from '../src/main/proxy/utils/usageEstimate.ts'

/** Fail fast with a message. */
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(estimateTextTokens('hello') >= 1, 'ascii tokens')
assert(estimateTextTokens('你好世界') >= 4, 'cjk tokens')
assert(isPlaceholderUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), 'stub')
assert(isPlaceholderUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 999 }), 'total-only')
assert(!isPlaceholderUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }), 'real')

const messages = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: '列出目录结构并说明项目用途' },
]
const prompt = estimatePromptTokens(messages, [
  { type: 'function', function: { name: 'read', parameters: {} } },
])
assert(prompt > 10, 'prompt estimate ' + prompt)

const body = ensureCompletionUsage(
  {
    choices: [{ message: { role: 'assistant', content: '这是一个测试回复。' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  messages
)
assert(body.usage.prompt_tokens > 1, 'ensured prompt')
assert(body.usage.completion_tokens > 1, 'ensured completion')

const chunks = []
const inject = createUsageInjectTransform({
  requestId: 'chatcmpl-test',
  model: 'Kimi-K2.6',
  messages,
})
inject.on('data', (c) => chunks.push(c.toString()))

await new Promise((resolve, reject) => {
  inject.on('end', resolve)
  inject.on('error', reject)
  inject.write(
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"Kimi-K2.6","choices":[{"index":0,"delta":{"content":"hello world"},"finish_reason":null}]}\n\n'
  )
  inject.write(
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"Kimi-K2.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  )
  inject.write('data: [DONE]\n\n')
  inject.end()
})

const out = chunks.join('')
assert(out.includes('"usage"'), 'usage injected')
assert(out.includes('"choices":[]'), 'empty choices usage chunk')
assert(out.includes('[DONE]'), 'done present')
assert(out.indexOf('"usage"') < out.indexOf('[DONE]'), 'usage before done')

const usageMatch = out.match(/"usage":\{[^}]+\}/)
console.log('ok', { prompt, bodyUsage: body.usage, usageChunk: usageMatch?.[0] })
