import type { Hono } from 'hono'
import { getModelSpec } from '../config/models.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import { ChatCompletionRequestSchema } from '../schemas/chat.js'
import { withEarlyKeepalive } from '../streaming/earlyKeepalive.js'
import { createMockSSEStream, sseHeaders } from '../streaming/sse.js'
import { withStallWatchdog } from '../streaming/stallWatchdog.js'
import type { Env } from '../types.js'

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
        c.header('x-clamped-max-tokens', clampedHeader)
      }
      // expose whether sanitize stripped anything for hermetic testing
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        strippedHeader = stripped.join(',')
        c.header('x-sanitize-stripped', strippedHeader)
      }
    }
    if (data.stream) {
      // P4 streaming engine — mock upstream wrapped with keepalive + watchdog, hermetic via app.request()
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
      const mock = createMockSSEStream({
        model: data.model,
        format: 'openai',
        signal: upstreamController.signal,
      })
      const withKeepalive = withEarlyKeepalive(mock, {
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
