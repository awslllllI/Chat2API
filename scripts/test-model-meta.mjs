/**
 * Smoke test for conservative model metadata helpers.
 */
import {
  resolveModelMeta,
  enrichModelInfo,
  WEB_CONTEXT_CAP,
} from '../src/main/proxy/config/modelMeta.ts'

/** Fail with message. */
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const kimi = resolveModelMeta('Kimi-K2.6')
assert(kimi?.contextLength === 262144, 'kimi context')
assert(kimi?.inputModalities.includes('image'), 'kimi vision')

const flash = resolveModelMeta('deepseek-v4-flash-think-search')
assert(flash?.contextLength === WEB_CONTEXT_CAP, 'flash capped')
assert(flash?.contextLength <= WEB_CONTEXT_CAP, 'no 1M')
assert(flash?.inputModalities.includes('image'), 'flash vision')

const pro = resolveModelMeta('deepseek-v4-pro')
assert(pro?.contextLength === WEB_CONTEXT_CAP, 'pro capped')
assert(!pro?.inputModalities.includes('image'), 'pro text-only')

const enriched = enrichModelInfo({
  id: 'Kimi-K2.6',
  object: 'model',
  created: 1,
  owned_by: 'Kimi',
})
assert(enriched.context_length === 262144, 'ext context_length')
assert(enriched.max_output_tokens === 32768, 'ext max_output')
assert(Array.isArray(enriched.input_modalities), 'ext modalities')

for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro', 'Qwen3.7-Max', 'MiMo-V2.5-Pro']) {
  const m = resolveModelMeta(id)
  assert(m, `meta ${id}`)
  assert(m.contextLength <= WEB_CONTEXT_CAP, `${id} must not advertise >256K lightly`)
}

console.log('ok', {
  kimi: kimi.contextLength,
  flash: flash.contextLength,
  proInput: pro.inputModalities,
})
