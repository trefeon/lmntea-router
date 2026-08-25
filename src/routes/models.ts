import type { Hono } from 'hono'
import { getRequestId } from '../middleware/requestId.js'
import type { Env } from '../types.js'

export function mountModels(app: Hono<Env>) {
  app.get('/v1/models', (c) => {
    const now = Math.floor(Date.now() / 1000)
    return c.json({
      object: 'list',
      data: [
        {
          id: 'oc/x-preview-f-free',
          object: 'model',
          created: now,
          owned_by: 'opencode',
        },
        {
          id: 'oc/muse-spark-1.2-contributor-free',
          object: 'model',
          created: now,
          owned_by: 'opencode',
        },
      ],
    })
  })

  app.get('/v1/models/:id', (c) => {
    const id = c.req.param('id') ?? ''
    const models = ['oc/x-preview-f-free', 'oc/muse-spark-1.2-contributor-free']
    if (!models.includes(id)) {
      const requestId = getRequestId(c)
      return c.json(
        {
          error: {
            type: 'not_found_error',
            message: 'Model not found',
            code: 'MODEL_NOT_FOUND',
          },
          ...(requestId ? { request_id: requestId } : {}),
        },
        404,
      )
    }
    return c.json({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'opencode',
    })
  })
}
