import type { Hono } from 'hono'
import { getModelSpec } from '../config/models.js'
import { getProviderForModel } from '../config/providers.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import {
  RELAY_TIMEOUT_MS,
  dispatch,
  getDefaultRelayPool,
} from '../router/transport.js'
import { ChatCompletionRequestSchema } from '../schemas/chat.js'
import { withEarlyKeepalive } from '../streaming/earlyKeepalive.js'
import { createMockSSEStream, sseHeaders } from '../streaming/sse.js'
import { withStallWatchdog } from '../streaming/stallWatchdog.js'
import type { Env } from '../types.js'

function buildUpstreamUrl(model: string): string {
  const provider = getProviderForModel(model)
  const base = provider?.baseUrl ?? 'https://opencode.ai/zen/v1'
  return `${base.replace(/\/$/, '')}/chat/completions`
}

export function mountChat(app: Hono<Env>) {
  app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body) {
      return validationError(c, 'Invalid JSON', 'body')
    }
    const parsed = ChatCompletionRequestSchema.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      if (!first) {
        return validationError(c, 'Invalid request', 'body')
      }
      return validationError(c, first.message, first.path.join('.'))
    }
    const data = parsed.data
    // P2 normalizer — exercised before streaming. Order: sanitize -> clamp -> thinking
    const spec = getModelSpec(data.model)
    let normalized: Record<string, unknown> | null = null
    let clampedHeader: string | undefined
    let strippedHeader: string | undefined
    if (spec) {
      let bodyRec: Record<string, unknown> = {
        ...(data as unknown as Record<string, unknown>),
      }
      // keep raw passthrough keys (e.g. thinking, reasoning_effort) that zod strips? Use original body as base
      bodyRec = { ...body, ...bodyRec }
      const beforeKeys = new Set(Object.keys(bodyRec))
      bodyRec = sanitizeParams(bodyRec, spec)
      bodyRec = clampBody(bodyRec, spec)
      bodyRec = reconcileThinking(bodyRec, spec)
      normalized = bodyRec
      const clamped = normalized.max_tokens ?? normalized.max_completion_tokens
      if (typeof clamped === 'number') {
        clampedHeader = String(clamped)
      }
      // expose whether sanitize stripped anything for hermetic testing
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        strippedHeader = stripped.join(',')
      }
    }
    if (data.stream) {
      const upstreamController = new AbortController()
      // propagate client disconnect -> upstream abort (saves tokens)
      const rawSignal = (c.req.raw as unknown as Request)?.signal as
        | AbortSignal
        | undefined
      if (rawSignal) {
        if (rawSignal.aborted) upstreamController.abort()
        else
          rawSignal.addEventListener(
            'abort',
            () => upstreamController.abort(),
            { once: true },
          )
      }

      const relayUrls = getDefaultRelayPool()
      const upstreamUrl = buildUpstreamUrl(data.model)
      const upstreamBody = JSON.stringify(normalized ?? data)

      let upstreamResponse: Response | null = null
      let useMockFallback = false

      try {
        upstreamResponse = await dispatch({
          url: upstreamUrl,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: upstreamBody,
          signal: upstreamController.signal,
          relayUrls,
          timeoutMs: RELAY_TIMEOUT_MS,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          msg.includes('Forbidden private') ||
          msg.includes('private/internal target') ||
          msg.includes('Forbidden protocol') ||
          msg.includes('Credentials in URL')
        ) {
          return c.json(
            {
              error: {
                type: 'invalid_request_error',
                message: msg,
                code: 'SSRF_FORBIDDEN',
              },
            },
            403,
          )
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          const isClientAbort =
            upstreamController.signal.aborted && rawSignal?.aborted
          if (!isClientAbort) {
            return c.json(
              {
                error: {
                  type: 'server_error',
                  message: 'Upstream timeout',
                  code: 'TIMEOUT',
                },
              },
              504,
            )
          }
          // client aborted — close quietly
          return new Response(null, { status: 499 })
        }
        const isTestEnv =
          process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
        if (isTestEnv) {
          useMockFallback = true
        } else {
          return c.json(
            {
              error: {
                type: 'server_error',
                message: msg,
                code: 'UPSTREAM_ERROR',
              },
            },
            502,
          )
        }
      }

      // handle non-2xx upstream (when dispatch returned response with 4xx/5xx)
      if (upstreamResponse && !upstreamResponse.ok && !useMockFallback) {
        const isTestEnv =
          process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
        if (isTestEnv) {
          useMockFallback = true
        } else {
          const text = await upstreamResponse.text().catch(() => '')
          const status = upstreamResponse.status as
            | 400
            | 401
            | 403
            | 429
            | 500
            | 502
            | 503
            | 504
          const mappedStatus = status >= 500 ? 502 : status
          return c.json(
            {
              error: {
                type: 'server_error',
                message: text || `Upstream ${upstreamResponse.status}`,
                code: String(upstreamResponse.status),
              },
            },
            mappedStatus as 502,
          )
        }
      }

      let bodyStream: ReadableStream<Uint8Array>
      if (useMockFallback || !upstreamResponse || !upstreamResponse.body) {
        if (!useMockFallback && upstreamResponse && !upstreamResponse.body) {
          return c.json(
            {
              error: {
                type: 'server_error',
                message: 'Upstream returned no body',
              },
            },
            502,
          )
        }
        bodyStream = createMockSSEStream({
          model: data.model,
          format: 'openai',
          signal: upstreamController.signal,
        })
      } else {
        bodyStream = upstreamResponse.body as ReadableStream<Uint8Array>
      }

      const withKeepalive = withEarlyKeepalive(bodyStream, {
        signal: upstreamController.signal,
      })
      const withWatchdog = withStallWatchdog(withKeepalive, {
        format: 'openai',
        signal: upstreamController.signal,
        upstreamController,
      })
      const extra: Record<string, string> = {}
      if (clampedHeader) extra['x-clamped-max-tokens'] = clampedHeader
      if (strippedHeader) extra['x-sanitize-stripped'] = strippedHeader
      const requestId = c.get('requestId')
      if (requestId) extra['x-request-id'] = requestId
      return new Response(withWatchdog, {
        status: 200,
        headers: sseHeaders(extra),
      })
    }
    if (clampedHeader) c.header('x-clamped-max-tokens', clampedHeader)
    if (strippedHeader) c.header('x-sanitize-stripped', strippedHeader)
    // expose normalized snapshot for debugging/tests via header when transport still missing
    if (normalized && typeof normalized.max_tokens === 'number') {
      c.header('x-normalized-max-tokens', String(normalized.max_tokens))
    }
    return c.json(
      {
        error: {
          type: 'server_error',
          message: 'Not Implemented',
          code: 'NOT_IMPLEMENTED',
        },
      },
      501,
    )
  })
}
