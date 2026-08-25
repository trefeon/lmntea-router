import type { Context, Next } from 'hono'
import type { Env } from '../types.js'

export function getRequestId(c: Context<Env>): string {
  return c.get('requestId') ?? c.req.header('x-request-id') ?? ''
}

export async function requestId(c: Context<Env>, next: Next) {
  const existing = c.req.header('x-request-id')
  const id = existing?.trim() ? existing.trim() : crypto.randomUUID()
  c.set('requestId', id)
  c.header('x-request-id', id)
  await next()
}
