import type { Context, Next } from 'hono'
import { recordUsage } from '../observability/usage.js'
import type { Env } from '../types.js'

export async function usageMiddleware(c: Context<Env>, next: Next) {
  const startedAt = performance.now()
  await next()

  const model = c.get('usageModel')
  if (model === undefined) return

  recordUsage({
    model,
    status: c.res.status,
    durationMs: performance.now() - startedAt,
  })
}
