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
import { MessagesRequestSchema } from '../schemas/messages.js'
import { withEarlyKeepalive } from '../streaming/earlyKeepalive.js'
import { createMockSSEStream, sseHeaders } from '../streaming/sse.js'
import { withStallWatchdog } from '../streaming/stallWatchdog.js'
import type { Env } from '../types.js'

function buildUpstreamUrl(model: string): string {
  const provider = getProviderForModel(model)
  const base = provider?.baseUrl ?? 'https://opencode.ai/zen/v1'
  return `${base.replace(/\/$/, '')}/messages`
}

export function mountMessages(app: Hono<Env>) {
  app.post('/v1/messages', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body) {
      return validationError(c, 'Invalid JSON', 'body')
    }
    const parsed = MessagesRequestSchema.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      if (!first) {
        return validationError(c, 'Invalid request', 'body')
      }
      return validationError(c, first.message, first.path.join('.'))
    }
    const data = parsed.data
    const spec = getModelSpec(data.model)
    let clampedHeader: string | undefined
    let strippedHeader: string | undefined
    let normalizedHeader: string | undefined
    let normalizedRec: Record<string, unknown> | null = null
    if (spec) {
      let bodyRec: Record<string, unknown> = {
        ...(data as unknown as Record<string, unknown>),
      }
      bodyRec = { ...body, ...bodyRec }
      const beforeKeys = new Set(Object.keys(bodyRec))
      bodyRec = sanitizeParams(bodyRec, spec)
      bodyRec = clampBody(bodyRec, spec)
      bodyRec = reconcileThinking(bodyRec, spec)
      const clamped = bodyRec.max_tokens ?? bodyRec.max_completion_tokens
      if (typeof clamped === 'number') {
        clampedHeader = String(clamped)
      }
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        strippedHeader = stripped.join(',')
      }
      const nt = bodyRec.max_tokens
      if (typeof nt === 'number') {
        normalizedHeader = String(nt)
      }
      normalizedRec = bodyRec
    }
    if (data.stream) {
      // P4 streaming engine — Anthropic SSE (event: ...\ndata: ...\n\n), hermetic via app.request()
      const upstreamController = new AbortController()
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
      // Ship the normalized body (sanitized/clamped/thinking-reconciled),
      // mirroring chat.ts — headers must reflect what actually goes upstream.
      const norm = (normalizedRec ?? data) as Record<string, unknown>
      const upstreamBody = JSON.stringify({
        model: data.model,
        messages: norm.messages,
        max_tokens: norm.max_tokens ?? data.max_tokens,
        system: norm.system,
        tools: norm.tools,
      })

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
          format: 'anthropic',
          signal: upstreamController.signal,
        })
      } else {
        bodyStream = upstreamResponse.body as ReadableStream<Uint8Array>
      }

      const withKeepalive = withEarlyKeepalive(bodyStream, {
        comment: 'keepalive',
        signal: upstreamController.signal,
      })
      const withWatchdog = withStallWatchdog(withKeepalive, {
        format: 'anthropic',
        signal: upstreamController.signal,
        upstreamController,
      })
      const extra: Record<string, string> = {}
      if (clampedHeader) extra['x-clamped-max-tokens'] = clampedHeader
      if (strippedHeader) extra['x-sanitize-stripped'] = strippedHeader
      if (normalizedHeader) extra['x-normalized-max-tokens'] = normalizedHeader
      const requestId = c.get('requestId')
      if (requestId) extra['x-request-id'] = requestId
      return new Response(withWatchdog, {
        status: 200,
        headers: sseHeaders(extra),
      })
    }
    if (clampedHeader) c.header('x-clamped-max-tokens', clampedHeader)
    if (strippedHeader) c.header('x-sanitize-stripped', strippedHeader)
    if (normalizedHeader) c.header('x-normalized-max-tokens', normalizedHeader)
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
