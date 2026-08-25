import type { Hono } from 'hono'
import { validationError } from '../middleware/errors.js'
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
