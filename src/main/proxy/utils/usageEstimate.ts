/**
 * Token usage estimation and OpenAI-compatible usage chunk helpers.
 * Web providers often omit real usage; DSH/Codex meters and compaction need
 * prompt_tokens / completion_tokens / total_tokens on the final stream chunk.
 */

import { Transform } from 'stream'
import type { ChatMessage, ChatCompletionTool } from '../types'

/** OpenAI-style usage payload */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * Estimate tokens for a string (CJK ≈ 1 token/char, ASCII ≈ 4 chars/token).
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) > 127 ? 1 : 0.25
  }
  return Math.max(1, Math.ceil(tokens))
}

/**
 * Estimate tokens for a chat message content field.
 */
export function estimateContentTokens(content: ChatMessage['content']): number {
  if (content === null || content === undefined) return 0
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((total, part: any) => {
      if (part?.type === 'text' && part.text) {
        return total + estimateTextTokens(String(part.text))
      }
      if (part?.type === 'image_url' || part?.type === 'image') {
        return total + 765
      }
      return total
    }, 0)
  }
  return estimateTextTokens(JSON.stringify(content))
}

/**
 * Estimate prompt tokens from messages plus optional tools JSON.
 */
export function estimatePromptTokens(
  messages: ChatMessage[] | undefined,
  tools?: ChatCompletionTool[] | unknown[]
): number {
  let total = 0
  for (const msg of messages || []) {
    total += 4
    if (msg.role) total += estimateTextTokens(String(msg.role))
    total += estimateContentTokens(msg.content)
    if ((msg as any).name) total += estimateTextTokens(String((msg as any).name))
    if ((msg as any).tool_calls) {
      total += estimateTextTokens(JSON.stringify((msg as any).tool_calls))
    }
    if ((msg as any).tool_call_id) {
      total += estimateTextTokens(String((msg as any).tool_call_id))
    }
  }
  if (tools && Array.isArray(tools) && tools.length > 0) {
    total += estimateTextTokens(JSON.stringify(tools))
  }
  return Math.max(1, total)
}

/**
 * Build a usage object from prompt and completion estimates.
 */
export function buildUsage(promptTokens: number, completionTokens: number): TokenUsage {
  const prompt_tokens = Math.max(0, Math.floor(promptTokens))
  const completion_tokens = Math.max(0, Math.floor(completionTokens))
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  }
}

/**
 * Detect placeholder / missing usage that DSH should not trust.
 * Treats Chat2API legacy `1/1/2` and DeepSeek-style total-only stubs as unusable.
 */
export function isPlaceholderUsage(usage: Partial<TokenUsage> | null | undefined): boolean {
  if (!usage) return true
  const prompt = Number(usage.prompt_tokens) || 0
  const completion = Number(usage.completion_tokens) || 0
  const total = Number(usage.total_tokens) || 0
  if (prompt <= 0 && completion <= 0 && total <= 0) return true
  // Legacy stubs or upstream that only fills total_tokens
  if (prompt <= 1 && completion <= 1) return true
  return false
}

/**
 * Prefer real upstream usage; otherwise fill with estimates.
 */
export function coalesceUsage(
  existing: Partial<TokenUsage> | null | undefined,
  estimated: TokenUsage
): TokenUsage {
  if (!isPlaceholderUsage(existing)) {
    const prompt_tokens = Number(existing!.prompt_tokens) || 0
    const completion_tokens = Number(existing!.completion_tokens) || 0
    let total_tokens = Number(existing!.total_tokens) || 0
    if (total_tokens <= 0) total_tokens = prompt_tokens + completion_tokens
    // DeepSeek-style: only total is real
    if (prompt_tokens <= 1 && completion_tokens <= 1 && total_tokens > 2) {
      return {
        prompt_tokens: estimated.prompt_tokens,
        completion_tokens: Math.max(0, total_tokens - estimated.prompt_tokens),
        total_tokens,
      }
    }
    return { prompt_tokens, completion_tokens, total_tokens }
  }
  return estimated
}

/**
 * Format the OpenAI final usage SSE chunk (choices must be empty).
 */
export function formatUsageChunk(params: {
  id: string
  model: string
  created: number
  usage: TokenUsage
}): string {
  return `data: ${JSON.stringify({
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [],
    usage: params.usage,
  })}\n\n`
}

/**
 * Extract assistant text / reasoning deltas and any usage from collected SSE body.
 */
export function parseSseUsageSignals(sseText: string): {
  hasUsage: boolean
  usage: TokenUsage | null
  completionText: string
  lastId: string | null
  lastModel: string | null
  lastCreated: number | null
} {
  let hasUsage = false
  let usage: TokenUsage | null = null
  let completionText = ''
  let lastId: string | null = null
  let lastModel: string | null = null
  let lastCreated: number | null = null

  for (const rawLine of sseText.split(/\n/)) {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trimStart()
    if (!payload || payload === '[DONE]') continue
    try {
      const data = JSON.parse(payload)
      if (data.id) lastId = String(data.id)
      if (data.model) lastModel = String(data.model)
      if (typeof data.created === 'number') lastCreated = data.created
      if (data.usage && !isPlaceholderUsage(data.usage)) {
        hasUsage = true
        usage = coalesceUsage(data.usage, {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        })
      }
      const delta = data.choices?.[0]?.delta
      if (delta?.content) completionText += String(delta.content)
      if (delta?.reasoning_content) completionText += String(delta.reasoning_content)
      if (Array.isArray(delta?.tool_calls)) {
        completionText += JSON.stringify(delta.tool_calls)
      }
    } catch {
      // skip non-JSON SSE lines
    }
  }

  return { hasUsage, usage, completionText, lastId, lastModel, lastCreated }
}

export interface UsageInjectOptions {
  /** Request id used when adapters omit chunk ids */
  requestId: string
  /** Model name for the usage chunk */
  model: string
  /** Messages used to estimate prompt_tokens */
  messages: ChatMessage[]
  /** Tools included in the prompt estimate */
  tools?: ChatCompletionTool[] | unknown[]
  /** Always emit a trailing usage chunk even if stream_options omitted */
  force?: boolean
}

/**
 * Create a transform that injects a final OpenAI usage chunk before [DONE]
 * when the upstream SSE never reported usable usage.
 */
export function createUsageInjectTransform(options: UsageInjectOptions): Transform {
  let buffer = ''
  let sawRealUsage = false
  let completionText = ''
  let lastId = options.requestId
  let lastModel = options.model
  let lastCreated = Math.floor(Date.now() / 1000)
  let closed = false

  /**
   * Consume complete SSE frames from the buffer and forward them.
   */
  function drain(push: (chunk: string) => void, ending: boolean): void {
    while (true) {
      const sep = buffer.indexOf('\n\n')
      if (sep === -1) {
        if (ending && buffer.length > 0) {
          handleFrame(buffer, push)
          buffer = ''
        }
        return
      }
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      handleFrame(frame, push)
    }
  }

  /**
   * Process one SSE frame; inject usage immediately before [DONE].
   */
  function handleFrame(frame: string, push: (chunk: string) => void): void {
    const trimmed = frame.trim()
    if (!trimmed) return

    const isDone = /^data:\s*\[DONE\]\s*$/m.test(trimmed)
    if (isDone) {
      if (!sawRealUsage) {
        const promptTokens = estimatePromptTokens(options.messages, options.tools)
        const completionTokens = Math.max(1, estimateTextTokens(completionText || ' '))
        const usage = buildUsage(promptTokens, completionTokens)
        push(formatUsageChunk({
          id: lastId,
          model: lastModel,
          created: lastCreated,
          usage,
        }))
        sawRealUsage = true
      }
      push(trimmed.endsWith('\n') ? `${trimmed}\n` : `${trimmed}\n\n`)
      return
    }

    for (const rawLine of frame.split(/\n/)) {
      const line = rawLine.trimEnd()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trimStart()
      if (!payload || payload === '[DONE]') continue
      try {
        const data = JSON.parse(payload)
        if (data.id) lastId = String(data.id)
        if (data.model) lastModel = String(data.model)
        if (typeof data.created === 'number') lastCreated = data.created
        if (data.usage && !isPlaceholderUsage(data.usage)) {
          sawRealUsage = true
        }
        const delta = data.choices?.[0]?.delta
        if (delta?.content) completionText += String(delta.content)
        if (delta?.reasoning_content) completionText += String(delta.reasoning_content)
        if (Array.isArray(delta?.tool_calls)) {
          completionText += JSON.stringify(delta.tool_calls)
        }
      } catch {
        // ignore parse errors for non-JSON data lines
      }
    }

    push(frame.endsWith('\n') ? `${frame}\n` : `${frame}\n\n`)
  }

  return new Transform({
    /**
     * Buffer and rewrite SSE chunks on the fly.
     */
    transform(chunk, _enc, callback) {
      try {
        buffer += chunk.toString()
        const out: string[] = []
        drain((s) => out.push(s), false)
        if (out.length) this.push(out.join(''))
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
    /**
     * Flush remainder and ensure a usage chunk exists before close.
     */
    flush(callback) {
      try {
        if (closed) {
          callback()
          return
        }
        closed = true
        const out: string[] = []
        drain((s) => out.push(s), true)
        if (!sawRealUsage) {
          const promptTokens = estimatePromptTokens(options.messages, options.tools)
          const completionTokens = Math.max(1, estimateTextTokens(completionText || ' '))
          out.push(formatUsageChunk({
            id: lastId,
            model: lastModel,
            created: lastCreated,
            usage: buildUsage(promptTokens, completionTokens),
          }))
          out.push('data: [DONE]\n\n')
          sawRealUsage = true
        }
        if (out.length) this.push(out.join(''))
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
  })
}

/**
 * Ensure a non-stream chat.completion body carries usable usage numbers.
 */
export function ensureCompletionUsage(
  body: any,
  messages: ChatMessage[],
  tools?: ChatCompletionTool[] | unknown[]
): any {
  if (!body || typeof body !== 'object') return body
  const completionText =
    body.choices?.[0]?.message?.content ||
    body.choices?.[0]?.message?.reasoning_content ||
    ''
  const toolCalls = body.choices?.[0]?.message?.tool_calls
  const completionSource =
    (typeof completionText === 'string' ? completionText : JSON.stringify(completionText || '')) +
    (toolCalls ? JSON.stringify(toolCalls) : '')
  const estimated = buildUsage(
    estimatePromptTokens(messages, tools),
    Math.max(1, estimateTextTokens(completionSource || ' '))
  )
  return {
    ...body,
    usage: coalesceUsage(body.usage, estimated),
  }
}
