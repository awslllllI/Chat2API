export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

/**
 * Resolve DeepSeek chat mode flags from model alias / request params.
 */
export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

/** Legacy scenario strings still accepted by ChatService */
export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_K2D6' | 'SCENARIO_CHAT' | 'SCENARIO_K3'

/**
 * Map display/upstream model id to Kimi chat scenario.
 * K2.6 fast path keeps SCENARIO_K2D6; K3 agent uses SCENARIO_K3 when requested.
 */
export function resolveKimiScenario(model: string): KimiScenario {
  const lower = model.toLowerCase()
  if (lower.includes('k3') && !lower.includes('k2')) return 'SCENARIO_K3'
  if (lower.includes('k2.6') || lower.includes('k2d6')) return 'SCENARIO_K2D6'
  if (lower.includes('k2.5') || lower.includes('k2d5')) return 'SCENARIO_K2D5'
  return 'SCENARIO_CHAT'
}

/**
 * kimi.common.v1.ReasoningEffort enum names used by Connect JSON.
 * UI「标准 / 进阶」typically map to MEDIUM / HIGH among available options.
 */
export type KimiReasoningEffort =
  | 'REASONING_EFFORT_UNSPECIFIED'
  | 'REASONING_EFFORT_NONE'
  | 'REASONING_EFFORT_MINIMAL'
  | 'REASONING_EFFORT_LOW'
  | 'REASONING_EFFORT_MEDIUM'
  | 'REASONING_EFFORT_HIGH'
  | 'REASONING_EFFORT_XHIGH'
  | 'REASONING_EFFORT_MAX'

/** kimi.common.v1.Speed */
export type KimiSpeed = 'SPEED_UNSPECIFIED' | 'SPEED_STANDARD' | 'SPEED_FAST' | 'SPEED_MAX'

/**
 * Resolve thinking intensity from OpenAI reasoning_effort / model alias.
 */
export function resolveKimiReasoningEffort(
  model: string,
  reasoningEffort?: string | boolean | null,
  enableThinking?: boolean,
): KimiReasoningEffort | undefined {
  const modelLower = model.toLowerCase()
  const raw =
    typeof reasoningEffort === 'string'
      ? reasoningEffort.toLowerCase()
      : reasoningEffort
        ? 'medium'
        : ''

  const fromModel =
    modelLower.includes('think-advanced') ||
    modelLower.includes('thinking-advanced') ||
    modelLower.includes('xhigh') ||
    modelLower.includes('进阶')
      ? 'high'
      : modelLower.includes('think') || modelLower.includes('reason')
        ? 'medium'
        : ''

  const key = raw || fromModel
  if (!key && !enableThinking) return undefined

  switch (key) {
    case 'none':
    case 'off':
      return 'REASONING_EFFORT_NONE'
    case 'minimal':
      return 'REASONING_EFFORT_MINIMAL'
    case 'low':
      return 'REASONING_EFFORT_LOW'
    case 'high':
    case 'advanced':
    case '进阶':
      return 'REASONING_EFFORT_HIGH'
    case 'xhigh':
    case 'x-high':
      return 'REASONING_EFFORT_XHIGH'
    case 'max':
      return 'REASONING_EFFORT_MAX'
    case 'medium':
    case 'standard':
    case '标准':
    case 'true':
    default:
      // enableThinking without intensity → 标准 (MEDIUM)
      return 'REASONING_EFFORT_MEDIUM'
  }
}

/**
 * Fast chat models use SPEED_FAST when the site only exposes the quick path.
 */
export function resolveKimiSpeed(model: string): KimiSpeed {
  const lower = model.toLowerCase()
  if (lower.includes('max') && lower.includes('speed')) return 'SPEED_MAX'
  if (lower.includes('standard') && lower.includes('speed')) return 'SPEED_STANDARD'
  // Default web "快速模型"
  return 'SPEED_FAST'
}

/**
 * Build Connect+JSON Chat payload matching Kimi web (text + native file blocks).
 */
export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
  /** OpenAI-style reasoning_effort or Chinese 标准/进阶 */
  reasoningEffort?: string | boolean | null
  /** Uploaded file ids from /apiv2-files/file/upload */
  files?: Array<{ id: string }>
}) {
  const scenario = resolveKimiScenario(options.model)
  const reasoningEffort = resolveKimiReasoningEffort(
    options.model,
    options.reasoningEffort,
    options.enableThinking,
  )
  const thinking = Boolean(options.enableThinking || reasoningEffort)
  const blocks: Array<Record<string, unknown>> = []

  if (options.content) {
    blocks.push({
      message_id: '',
      text: { content: options.content },
    })
  }

  for (const file of options.files || []) {
    if (!file?.id) continue
    // ProcessStatus.SUCCESS = 3; same shape the web client attaches after parse
    blocks.push({
      file: {
        id: file.id,
        status: 3,
        fail_reason: '',
      },
    })
  }

  if (blocks.length === 0) {
    blocks.push({
      message_id: '',
      text: { content: '' },
    })
  }

  const chatOptions: Record<string, unknown> = {
    thinking,
    speed: resolveKimiSpeed(options.model),
  }
  if (reasoningEffort) {
    chatOptions.reasoning_effort = reasoningEffort
  }

  return {
    scenario,
    chat_id: '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks,
      scenario,
    },
    options: chatOptions,
  }
}

/**
 * Encode a Connect unary JSON frame.
 */
export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
