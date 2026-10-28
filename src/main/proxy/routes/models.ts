/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route with capability metadata for DSH autofill plugins
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { storeManager } from '../../store/store'
import { enrichModelInfo } from '../config/modelMeta'

const router = new Router({ prefix: '/v1' })

/**
 * Build a model list entry with optional capability extensions.
 */
function buildModelEntry(
  id: string,
  created: number,
  ownedBy: string
): ModelInfo {
  return enrichModelInfo({
    id,
    object: 'model',
    created,
    owned_by: ownedBy,
  }) as ModelInfo
}

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (!addedModels.has(model.displayName)) {
        addedModels.add(model.displayName)
        models.push(buildModelEntry(
          model.displayName,
          Math.floor(provider.createdAt / 1000),
          provider.name,
        ))
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel] of Object.entries(mappings)) {
    if (!addedModels.has(requestModel)) {
      addedModels.add(requestModel)
      models.push(buildModelEntry(
        requestModel,
        Math.floor(Date.now() / 1000),
        'model-mapping',
      ))
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  if (mappings[modelId]) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = buildModelEntry(modelId, Math.floor(Date.now() / 1000), 'model-mapping')
    return
  }

  const providers = storeManager.getProviders().filter(p => p.enabled)

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const normalizedModelId = modelId.toLowerCase()
    const found = effectiveModels.some(m => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModelId
    })

    if (found) {
      ctx.set('Content-Type', 'application/json')
      ctx.body = buildModelEntry(
        modelId,
        Math.floor(provider.createdAt / 1000),
        provider.name,
      )
      return
    }
  }

  // Still return enriched stub for known catalog ids so discovery plugins can fill
  const enriched = enrichModelInfo({
    id: modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'unknown',
  }, modelId)
  if ((enriched as any).context_length) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = enriched
    return
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
