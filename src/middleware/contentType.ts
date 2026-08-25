import type { Context, Next } from 'hono'
import type { Env } from '../types.js'
import { unsupportedMediaType } from './errors.js'

export async function requireJson(c: Context<Env>, next: Next) {
  const method = c.req.method
  const path = c.req.path
  const needsJson =
    (method === 'POST' || method === 'PUT' || method === 'PATCH') &&
    (path.startsWith('/v1/') || path.startsWith('/api/'))
  if (!needsJson) return next()
  const ct = (
    c.req.header('content-type') ??
    c.req.header('Content-Type') ??
    ''
  ).toLowerCase()
  if (!ct.includes('application/json')) {
    return unsupportedMediaType(c)
  }
  return next()
}
