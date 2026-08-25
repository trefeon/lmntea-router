import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth.js'
import { bodyLimitMiddleware } from './middleware/bodyLimit.js'
import { requireJson } from './middleware/contentType.js'
import { getRequestId, requestId } from './middleware/requestId.js'
import { mountChat } from './routes/chat.js'
import { mountMessages } from './routes/messages.js'
import { mountModels } from './routes/models.js'
import type { Env } from './types.js'

const VERSION = '0.1.0'

export function createApp() {
  const app = new Hono<Env>()

  // Global middleware order: requestId -> contentTypeGuard (415) -> bodyLimit (413) -> auth (401, skip /health) -> routes
  app.use('*', requestId)
  app.use('*', requireJson)
  app.use('*', bodyLimitMiddleware())
  app.use('*', authMiddleware)

  // liveness — no auth (authMiddleware skips /health), but requestId still applied
  app.get('/health', (c) =>
    c.json({ status: 'ok', uptime: process.uptime(), version: VERSION }),
  )

  app.get('/health/live', (c) =>
    c.json({ status: 'ok', uptime: process.uptime(), version: VERSION }),
  )

  app.get('/health/ready', (c) =>
    c.json({
      status: 'ok',
      uptime: process.uptime(),
      version: VERSION,
      checks: { db: true, relay: true, upstream: true },
    }),
  )

  // P1 — v1 routes (auth + content-type + bodyLimit already applied globally, stubs return 501)
  mountChat(app)
  mountMessages(app)
  mountModels(app)

  // 404 — keep shape per 03-API-CONTRACTS
  app.notFound((c) => {
    const requestIdVal = getRequestId(c)
    return c.json(
      {
        error: {
          type: 'not_found_error',
          message: 'Not Found',
          code: 'NOT_FOUND',
        },
        ...(requestIdVal ? { request_id: requestIdVal } : {}),
      },
      404,
    )
  })

  // error handler
  app.onError((err, c) => {
    console.error('[lmntea-router] unhandled', err)
    const requestIdVal = getRequestId(c)
    return c.json(
      {
        error: {
          type: 'server_error',
          message: 'Internal Server Error',
          code: 'INTERNAL',
        },
        ...(requestIdVal ? { request_id: requestIdVal } : {}),
      },
      500,
    )
  })

  return app
}

export const app = createApp()

const port = Number(process.env.PORT ?? 3000)

// Bun is primary (bun --watch). Node fallback via @hono/node-server (platform exists on both, static import is fine).
// This branch is genuinely runtime-selected: Bun global only exists under `bun`.
// @ts-ignore — ImportMeta.main is Bun-specific
if (import.meta.main) {
  console.log(
    `[lmntea-router] listening on http://localhost:${port}  (GET /health)`,
  )
  // @ts-ignore — Bun global only when run via `bun`
  if (typeof Bun !== 'undefined') Bun.serve({ port, fetch: app.fetch })
  else
    serve({ fetch: app.fetch, port }, (info) => {
      console.log(
        `[lmntea-router] listening on http://localhost:${info.port}  (GET /health) [Node]`,
      )
    })
}

export default app
