import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import type { Env } from '../types.js'
import { unauthorized } from './errors.js'

export function hashKey(k: string): string {
  return createHash('sha256').update(k).digest('hex')
}

export function isAuthRequired(): boolean {
  const raw = (process.env.AUTH_TOKENS ?? process.env.API_KEYS ?? '').trim()
  return raw.length > 0
}

export async function authMiddleware(c: Context<Env>, next: Next) {
  if (c.req.path.startsWith('/health')) return next()
  if (!isAuthRequired()) return next()

  const raw = (process.env.AUTH_TOKENS ?? process.env.API_KEYS ?? '').trim()
  const allowed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const authHeader =
    c.req.header('authorization') ?? c.req.header('Authorization') ?? ''
  let bearer = ''
  if (authHeader.toLowerCase().startsWith('bearer '))
    bearer = authHeader.slice(7).trim()

  const xApiKey = c.req.header('x-api-key') ?? c.req.header('X-API-Key') ?? ''
  const anthropicKey =
    c.req.header('anthropic-api-key') ??
    c.req.header('x-anthropic-api-key') ??
    c.req.header('api-key') ??
    ''

  let token = ''
  if (bearer) token = bearer
  else if (xApiKey) token = xApiKey.trim()
  else if (anthropicKey) token = anthropicKey.trim()

  if (!token || !allowed.includes(token)) {
    return unauthorized(c)
  }
  c.set('auth', { keyHash: hashKey(token).slice(0, 8) })
  return next()
}
