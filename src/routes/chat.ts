import type { Hono } from 'hono'
import { getModelSpec } from '../config/models.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import { ChatCompletionRequestSchema } from '../schemas/chat.js'
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
    // P2 normalizer — exercised before 501 stub (transport missing). Order: sanitize -> clamp -> thinking
    const spec = getModelSpec(data.model)
    let normalized: Record<string, unknown> | null = null
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
        c.header('x-clamped-max-tokens', String(clamped))
      }
      // expose whether sanitize stripped anything for hermetic testing
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        c.header('x-sanitize-stripped', stripped.join(','))
      }
    }
    if (data.stream) {
      const bodyText = `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`
      return c.body(bodyText, 501, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
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
