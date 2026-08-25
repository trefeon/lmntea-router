import type { Hono } from 'hono'
import { validationError } from '../middleware/errors.js'
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
