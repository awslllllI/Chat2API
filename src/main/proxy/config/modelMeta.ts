/**
 * Built-in model capability metadata for OpenAI-compatible /v1/models.
 * Values are intentionally conservative for Chat2API's web reverse-proxy path:
 * documented API windows above 256K are capped unless the web channel is verified.
 */

/** Supported request input modalities */
export type ModelInputModality = 'text' | 'image'

/** Capability profile exposed on model list / detail endpoints */
export interface ModelMetaProfile {
  /** Display / routing model id */
  id: string
  /** Human-readable name */
  name?: string
  /** Combined context window (tokens) */
  contextLength: number
  /** Maximum completion tokens */
  maxOutputTokens: number
  /** Accepted input modalities */
  inputModalities: ModelInputModality[]
  /** Short note about confidence / capping */
  notes?: string
}

/** Soft cap for unverified web-proxy long context (do not advertise 1M lightly). */
export const WEB_CONTEXT_CAP = 262_144

/** Default max output when docs are unclear. */
export const DEFAULT_MAX_OUTPUT = 32_768

/**
 * Cap a claimed context window for the web proxy path.
 */
export function capWebContext(claimed: number): number {
  return Math.min(Math.max(1, claimed), WEB_CONTEXT_CAP)
}

/**
 * Canonical metadata keyed by Chat2API display model id (case-sensitive as listed).
 */
export const MODEL_META: Record<string, ModelMetaProfile> = {
  'Kimi-K2.6': {
    id: 'Kimi-K2.6',
    name: 'Kimi K2.6',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    inputModalities: ['text', 'image'],
    notes: 'Official 256K; API default max_tokens 32K',
  },

  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
    notes: 'Official API claims 1M; web proxy capped at 256K',
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
    notes: 'Official API claims 1M; web proxy capped at 256K; text-only',
  },

  'GLM-5.1': {
    id: 'GLM-5.1',
    name: 'GLM-5.1',
    contextLength: 200_000,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
    notes: 'Official ~200K / 128K out; output capped conservatively for web',
  },
  'GLM-5-Turbo': {
    id: 'GLM-5-Turbo',
    name: 'GLM-5-Turbo',
    contextLength: 200_000,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
  },
  'GLM-5V-Turbo': {
    id: 'GLM-5V-Turbo',
    name: 'GLM-5V-Turbo',
    contextLength: 200_000,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
  },
  'GLM-5': {
    id: 'GLM-5',
    name: 'GLM-5',
    contextLength: 200_000,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
  },
  'GLM-4.7': {
    id: 'GLM-4.7',
    name: 'GLM-4.7',
    contextLength: 200_000,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
  },

  'MiniMax-M2.7': {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextLength: 204_800,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
  },

  'Qwen3.6': {
    id: 'Qwen3.6',
    name: 'Qwen3.6',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
    notes: 'Plus-class docs claim 1M; web proxy capped at 256K',
  },
  'Qwen3.7-Max': {
    id: 'Qwen3.7-Max',
    name: 'Qwen3.7-Max',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
    notes: 'Official API 1M text; web proxy capped at 256K',
  },
  'Qwen3.6-Plus': {
    id: 'Qwen3.6-Plus',
    name: 'Qwen3.6-Plus',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
    notes: 'Official 1M multimodal; web proxy capped at 256K',
  },
  'Qwen3.5-Flash': {
    id: 'Qwen3.5-Flash',
    name: 'Qwen3.5-Flash',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
  },
  'Qwen3-Max': {
    id: 'Qwen3-Max',
    name: 'Qwen3-Max',
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    inputModalities: ['text'],
  },
  'Qwen3-Max-Thinking-Preview': {
    id: 'Qwen3-Max-Thinking-Preview',
    name: 'Qwen3-Max-Thinking-Preview',
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    inputModalities: ['text'],
  },
  'Qwen3-Coder': {
    id: 'Qwen3-Coder',
    name: 'Qwen3-Coder',
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    inputModalities: ['text'],
  },
  'Qwen3.6-35B-A3B': {
    id: 'Qwen3.6-35B-A3B',
    name: 'Qwen3.6-35B-A3B',
    contextLength: 32_768,
    maxOutputTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
  'Qwen3.6-27B': {
    id: 'Qwen3.6-27B',
    name: 'Qwen3.6-27B',
    contextLength: 32_768,
    maxOutputTokens: 8_192,
    inputModalities: ['text', 'image'],
  },

  'MiMo-V2.5-Pro': {
    id: 'MiMo-V2.5-Pro',
    name: 'MiMo-V2.5-Pro',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
    notes: 'Official 1M; web proxy capped; series may be retired upstream',
  },
  'MiMo-V2.5': {
    id: 'MiMo-V2.5',
    name: 'MiMo-V2.5',
    contextLength: WEB_CONTEXT_CAP,
    maxOutputTokens: 65_536,
    inputModalities: ['text', 'image'],
    notes: 'Official omni 1M; web proxy capped at 256K',
  },
  'MiMo-V2-Flash': {
    id: 'MiMo-V2-Flash',
    name: 'MiMo-V2-Flash',
    contextLength: 131_072,
    maxOutputTokens: 32_768,
    inputModalities: ['text'],
  },

  Auto: {
    id: 'Auto',
    name: 'Perplexity Auto',
    contextLength: 127_000,
    maxOutputTokens: 8_192,
    inputModalities: ['text'],
    notes: 'Perplexity web Auto; limits not firmly published',
  },
}

/** Suffix variants that inherit the base model meta (think / search flags). */
const VARIANT_SUFFIXES = ['-think', '-search', '-think-search', '-Search', '-Think'] as const

/**
 * Strip known Chat2API feature suffixes to resolve base model meta.
 */
export function stripModelVariantSuffix(modelId: string): string {
  let base = modelId
  for (const suffix of VARIANT_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix.toLowerCase())) {
      base = base.slice(0, base.length - suffix.length)
      break
    }
  }
  return base
}

/**
 * Look up metadata for a display model id (case-insensitive, variant-aware).
 */
export function resolveModelMeta(modelId: string): ModelMetaProfile | null {
  if (!modelId) return null
  if (MODEL_META[modelId]) return MODEL_META[modelId]

  const lowered = modelId.toLowerCase()
  for (const [key, value] of Object.entries(MODEL_META)) {
    if (key.toLowerCase() === lowered) return value
  }

  const base = stripModelVariantSuffix(modelId)
  if (base !== modelId) {
    return resolveModelMeta(base)
  }
  return null
}

/**
 * Build OpenAI-compatible extended fields for /v1/models consumers (DSH plugins).
 */
export function toOpenAIModelExtensions(meta: ModelMetaProfile): Record<string, unknown> {
  const modality = meta.inputModalities.includes('image') ? 'text+image' : 'text'
  return {
    name: meta.name || meta.id,
    context_length: meta.contextLength,
    context_window: meta.contextLength,
    max_model_len: meta.contextLength,
    max_tokens: meta.maxOutputTokens,
    max_output_tokens: meta.maxOutputTokens,
    max_completion_tokens: meta.maxOutputTokens,
    input_modalities: meta.inputModalities,
    supported_modalities: meta.inputModalities,
    modalities: meta.inputModalities,
    supports_vision: meta.inputModalities.includes('image'),
    architecture: {
      modality,
      input_modalities: meta.inputModalities,
      output_modalities: ['text'],
    },
  }
}

/**
 * Merge base model info with capability extensions when known.
 */
export function enrichModelInfo(
  base: { id: string; object: 'model'; created: number; owned_by: string },
  modelId: string = base.id
): Record<string, unknown> {
  const meta = resolveModelMeta(modelId)
  if (!meta) return { ...base }
  return {
    ...base,
    ...toOpenAIModelExtensions({ ...meta, id: modelId }),
  }
}
