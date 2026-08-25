import type { Context, Next } from 'hono'
import { bodyLimit as honoBodyLimit } from 'hono/body-limit'
import type { Env } from '../types.js'
import { payloadTooLarge } from './errors.js'

const getMaxBytes = (): number => {
  const raw = process.env.MAX_BODY_BYTES ?? ''
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return 1_000_000
}

export function bodyLimitMiddleware() {
  const limit = getMaxBytes()
  return async (c: Context<Env>, next: Next) => {
    const cl = c.req.header('content-length') ?? c.req.header('Content-Length')
    if (cl) {
      const n = Number(cl)
      if (Number.isFinite(n) && n > limit) {
        return payloadTooLarge(c)
      }
    }
    const hono = honoBodyLimit({
      maxSize: limit,
      onError: (ctx: Context<Env>) => payloadTooLarge(ctx),
    })
    return hono(c, next)
  }
}
