import type { ToolCallingPlan } from './types.ts'
import { getStreamWatchProtocols } from './protocols/index.ts'
import { parseToolContentWithFallback } from './parseFallback.ts'
import {
  looksLikeToolProtocolPrefix,
  sanitizeAssistantText,
} from './textCleanup.ts'

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0

  constructor(plan: ToolCallingPlan) {
    this.plan = plan
  }

  /**
   * Feed a content delta; emit text and/or tool_call chunks.
   */
  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || !this.plan.shouldParseResponse) return []

    this.buffer += content
    const chunks: any[] = []

    if (!this.isBufferingToolCall) {
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        if (markerStart.index > 0) {
          const prefix = sanitizeAssistantText(this.buffer.slice(0, markerStart.index), false)
          if (prefix) {
            chunks.push(createContentChunk(baseChunk, prefix, includeRole))
          }
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        if (markerStart.index > 0) {
          const prefix = sanitizeAssistantText(this.buffer.slice(0, markerStart.index), false)
          if (prefix) {
            chunks.push(createContentChunk(baseChunk, prefix, includeRole))
          }
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        // Stream deltas: keep whitespace; only strip control tokens.
        const text = sanitizeAssistantText(this.buffer, false)
        this.buffer = ''
        if (text) {
          chunks.push(createContentChunk(baseChunk, text, includeRole))
        }
        return chunks
      }
    }

    const parsed = parseToolContentWithFallback(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      for (const toolCall of parsed.toolCalls) {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall))
      }
      this.emittedToolCall = true
      this.isBufferingToolCall = false
      // Suppress trailing junk after tool calls (DSML crumbs, end tokens, etc.)
      this.buffer = ''
      return chunks
    }

    if (parsed.invalidToolNames.length > 0 || parsed.rawMatches.length > 0) {
      this.isBufferingToolCall = false
      this.buffer = ''
    }

    return chunks
  }

  /**
   * Flush remaining buffer at stream end.
   * Optional transform runs once on the full buffer (e.g. GLM dangling-tag finalize).
   */
  flush(baseChunk: any, transform?: (buffered: string) => string): any[] {
    if (transform && this.buffer) {
      this.buffer = transform(this.buffer)
    }
    if (!this.buffer) return []

    const parsed = parseToolContentWithFallback(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      const chunks = parsed.toolCalls.map((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return createToolCallChunk(baseChunk, indexedToolCall, false)
      })
      this.buffer = ''
      this.isBufferingToolCall = false
      return chunks
    }

    // After a tool call, never release leftover protocol junk as chat text.
    if (this.emittedToolCall || looksLikeToolProtocolPrefix(this.buffer)) {
      this.buffer = ''
      this.isBufferingToolCall = false
      return []
    }

    const text = sanitizeAssistantText(this.buffer)
    this.buffer = ''
    this.isBufferingToolCall = false
    return text ? [createContentChunk(baseChunk, text, false)] : []
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
  }
}

/**
 * Detect the earliest preferred or DSML tool-protocol marker in the buffer.
 */
function findMarkerStart(
  buffer: string,
  plan: ToolCallingPlan,
): { matched: boolean; partial: boolean; index: number } {
  const watchers = getStreamWatchProtocols(plan.protocol)
  const ranges = fencedRanges(buffer)
  let partialIndex = -1

  for (let index = 0; index < buffer.length; index += 1) {
    if (isInsideRange(index, ranges)) continue

    const suffix = buffer.slice(index)
    for (const protocol of watchers) {
      const detection = protocol.detectStart(suffix)
      if (detection.matched && detection.markerStart === 0) {
        return { matched: true, partial: false, index }
      }
      if (detection.partial && detection.markerStart === 0 && partialIndex === -1) {
        partialIndex = index
      }
    }

    // Broken Chat2API without leading '<' (do not match inside <|CHAT2API|...>)
    const prev = index > 0 ? buffer[index - 1] : ''
    if (suffix.startsWith('|CHAT2API|') && prev !== '<') {
      return { matched: true, partial: false, index }
    }
    if (prev !== '<' && '|CHAT2API|'.startsWith(suffix) && suffix.startsWith('|')) {
      if (partialIndex === -1) partialIndex = index
    }
  }

  return partialIndex === -1
    ? { matched: false, partial: false, index: -1 }
    : { matched: false, partial: true, index: partialIndex }
}

function fencedRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = /```[\s\S]*?```/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  return ranges
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        content,
      },
      finish_reason: null,
    }],
  }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText

  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        tool_calls: [openAiToolCall],
      },
      finish_reason: null,
    }],
  }
}
