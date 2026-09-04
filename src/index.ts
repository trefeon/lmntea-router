import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { startIntelligenceSync } from './intelligence/sync.js'
import { authMiddleware } from './middleware/auth.js'
import { bodyLimitMiddleware } from './middleware/bodyLimit.js'
import { requireJson } from './middleware/contentType.js'
import { getRequestId, requestId } from './middleware/requestId.js'
import { usageMiddleware } from './middleware/usage.js'
import { mountChat } from './routes/chat.js'
import { mountMessages } from './routes/messages.js'
import { mountModels } from './routes/models.js'
import { mountUsage } from './routes/usage.js'
import type { Env } from './types.js'

const VERSION = '0.2.0'

export function createApp() {
  const app = new Hono<Env>()

  // CORS — allow frontend dev (vite proxy + direct fetch)
  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'x-api-key',
        'anthropic-api-key',
        'x-request-id',
      ],
      exposeHeaders: [
        'x-clamped-max-tokens',
        'x-sanitize-stripped',
        'x-request-id',
      ],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    }),
  )

  // Global middleware order: requestId -> contentTypeGuard (415) -> bodyLimit (413) -> auth (401, skip /health) -> usage route middleware -> routes
  app.use('*', requestId)
  app.use('*', requireJson)
  app.use('*', bodyLimitMiddleware())
  app.use('*', authMiddleware)
  app.use('/v1/chat/completions', usageMiddleware)
  app.use('/v1/messages', usageMiddleware)
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
  mountUsage(app)

  // Serve frontend static (prod single-binary) — Hono serveStatic from apps/web/dist
  // In dev, vite handles it via proxy; in prod, node serves built assets
  // Only serves if file exists, otherwise falls through to 404 JSON (no SPA fallback on /v1)
  app.use('/*', serveStatic({ root: './apps/web/dist' }))
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
  // P6 intelligence — advisory background sync at server startup; never blocks
  // the event loop. Guarded to non-test runtimes: vitest imports this module
  // transitively via createApp() and must not open sync timers.
  const isTestRuntime =
    process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
  if (!isTestRuntime) startIntelligenceSync()
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
