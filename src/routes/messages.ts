import type { Hono } from 'hono'
import { getModelSpec } from '../config/models.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import { MessagesRequestSchema } from '../schemas/messages.js'
import { withEarlyKeepalive } from '../streaming/earlyKeepalive.js'
import { createMockSSEStream, sseHeaders } from '../streaming/sse.js'
import { withStallWatchdog } from '../streaming/stallWatchdog.js'
import type { Env } from '../types.js'

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
        c.header('x-clamped-max-tokens', clampedHeader)
      }
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        strippedHeader = stripped.join(',')
        c.header('x-sanitize-stripped', strippedHeader)
      }
      const nt = bodyRec.max_tokens
      if (typeof nt === 'number') {
        normalizedHeader = String(nt)
        c.header('x-normalized-max-tokens', normalizedHeader)
      }
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
      const mock = createMockSSEStream({
        model: data.model,
        format: 'anthropic',
        signal: upstreamController.signal,
      })
      const withKeepalive = withEarlyKeepalive(mock, {
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
