import { createHash, timingSafeEqual } from 'node:crypto'
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
  if (/^\/health(\/live|\/ready)?$/.test(c.req.path)) return next()
  // Static dashboard assets (serveStatic) carry no secrets — gating them would
  // 401 the UI in prod single-binary mode. Narrow allowlist: only vite build
  // output (/ index.html, /assets/*, favicon). Unknown paths keep 401 behavior.
  const p = c.req.path
  if (
    c.req.method === 'GET' &&
    !p.startsWith('/v1') &&
    !p.startsWith('/health') &&
    (p === '/' ||
      p === '/index.html' ||
      p.startsWith('/assets/') ||
      p === '/favicon.ico')
  ) {
    return next()
  }
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

  if (!token) return unauthorized(c)
  // Constant-time comparison: compare sha256 digests instead of raw tokens so
  // token length/content never leaks through early-exit string equality.
  const tokenDigest = Buffer.from(hashKey(token), 'hex')
  const match = allowed.some((k) =>
    timingSafeEqual(Buffer.from(hashKey(k), 'hex'), tokenDigest),
  )
  if (!match) {
    return unauthorized(c)
  }
  c.set('auth', { keyHash: hashKey(token).slice(0, 8) })
  return next()
}
