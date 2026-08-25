import type { Hono } from 'hono'
import { getModelSpec } from '../config/models.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import { MessagesRequestSchema } from '../schemas/messages.js'
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
        c.header('x-clamped-max-tokens', String(clamped))
      }
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        c.header('x-sanitize-stripped', stripped.join(','))
      }
      const nt = bodyRec.max_tokens
      if (typeof nt === 'number') {
        c.header('x-normalized-max-tokens', String(nt))
      }
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
