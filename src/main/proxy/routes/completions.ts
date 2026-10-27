/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import { accountGate } from '../accountGate'
import { resolveAccountRateLimits } from '../rateLimitDefaults'
import {
  clientAbortSignal,
  resolveAdmissionCapMs,
  selectAccountWithAdmissionWait,
  tryAcquireWithAdmissionWait,
} from '../admissionWait'
import { applyUpstreamFailure, applyEmptySuccessGuard } from '../accountHealth'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string | string[]): Array<{ role: string; content: string }> {
  if (Array.isArray(prompt)) {
    return prompt.map((p, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: p,
    }))
  }

  return [{ role: 'user', content: prompt }]
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)
  const admissionCapMs = resolveAdmissionCapMs(preferredProviderId || 'unknown')
  const abortSignal = clientAbortSignal(ctx.req)

  let selectResult
  try {
    selectResult = await selectAccountWithAdmissionWait(
      request.model,
      config.loadBalanceStrategy,
      preferredProviderId,
      preferredAccountId,
      admissionCapMs,
      abortSignal,
    )
  } catch (error) {
    if ((error as { code?: string })?.code === 'CLIENT_ABORTED') {
      ctx.status = 499
      ctx.body = { error: { message: 'Client closed request', type: 'aborted', code: 'client_aborted' } }
      return
    }
    throw error
  }
  const selection = selectResult.selection

  if (!selection) {
    if (selectResult.unavailabilityReason === 'accounts_unavailable') {
      ctx.status = 503
      ctx.body = {
        error: {
          message: `No usable account for model: ${request.model}. Accounts are paused, in error, or missing. Re-login or resume an account.${selectResult.unavailabilityDetail ? ` (${selectResult.unavailabilityDetail})` : ''}`,
          type: 'api_error',
          code: 'accounts_unavailable',
        },
      }
      return
    }
    const retryAfter = selectResult.retryAfterSeconds || 5
    ctx.status = 429
    ctx.set('Retry-After', String(retryAfter))
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}. Retry after ${retryAfter}s.`,
        type: 'rate_limit_error',
        code: 'no_available_account',
        retry_after: retryAfter,
      },
    }
    return
  }

  const { account, provider, actualModel } = selection
  const rateLimits = resolveAccountRateLimits(provider.id, account)
  const capMs = resolveAdmissionCapMs(provider.id, account)

  let acquire
  try {
    acquire = await tryAcquireWithAdmissionWait(account.id, rateLimits, capMs, abortSignal)
  } catch (error) {
    if ((error as { code?: string })?.code === 'CLIENT_ABORTED') {
      ctx.status = 499
      ctx.body = { error: { message: 'Client closed request', type: 'aborted', code: 'client_aborted' } }
      return
    }
    throw error
  }
  if (!acquire.acquired) {
    const retryAfter = Math.min(
      Math.max(Math.ceil((acquire.retryAfterMs || rateLimits.minIntervalMs || 5000) / 1000), 1),
      Math.ceil((rateLimits.retryAfterCapMs || 60_000) / 1000),
    )
    ctx.status = 429
    ctx.set('Retry-After', String(retryAfter))
    ctx.body = {
      error: {
        message: `Account temporarily busy for model: ${request.model}. Retry after ${retryAfter}s.`,
        type: 'rate_limit_error',
        code: 'account_busy',
        retry_after: retryAfter,
      },
    }
    return
  }

  const chatRequest = {
    model: actualModel,
    messages: promptToMessages(request.prompt),
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      chatRequest,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        startTime,
        isStream: request.stream || false,
      }
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)
      const classification = applyUpstreamFailure(account.id, result.status, result.error)
      const responseStatus =
        classification.kind === 'rate_limit' || result.status === 429
          ? 429
          : result.status || 500
      if (responseStatus === 429) {
        const retryAfter = Math.min(
          Math.max(Math.ceil((classification.coolDownMs || 60_000) / 1000), 1),
          15
        )
        ctx.set('Retry-After', String(retryAfter))
      }
      ctx.status = responseStatus
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: responseStatus === 429 ? 'rate_limit_error' : 'api_error',
          code: classification.kind,
        },
      }
      return
    }

    const emptyGuarded =
      !request.stream && result.body ? applyEmptySuccessGuard(account.id, result.body) : false
    if (!emptyGuarded) {
      loadBalancer.clearAccountFailure(account.id)
    }

    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.addLog('debug', `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    if (request.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const transformStream = streamHandler.createTransformStream(actualModel, requestId)
      result.stream.pipe(transformStream)
      ctx.body = transformStream
    } else {
      ctx.set('Content-Type', 'application/json')
      ctx.body = result.body
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    ctx.status = 500
    ctx.body = {
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        type: 'internal_error',
      },
    }
  } finally {
    accountGate.release(account.id, rateLimits)
  }
})

export default router
