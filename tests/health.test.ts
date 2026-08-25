import { describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'

describe('GET /health — canonical P0', () => {
  it('GET /health returns 200 {status:"ok", uptime, version} + json', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const body = (await res.json()) as {
      status: string
      uptime: number
      version: string
    }
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(body.version).toBe('0.1.0')
  })

  it('GET /health/live returns 200 {status:"ok"}', async () => {
    const app = createApp()
    const res = await app.request('/health/live')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('GET /health/ready returns 200 with checks', async () => {
    const app = createApp()
    const res = await app.request('/health/ready')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      checks: Record<string, boolean>
    }
    expect(body.status).toBe('ok')
    expect(body.checks).toEqual({ db: true, relay: true, upstream: true })
  })

  it('unknown route returns 404 json (with auth when required)', async () => {
    const orig = process.env.AUTH_TOKENS
    process.env.AUTH_TOKENS = 'sk-test'
    const app = createApp()
    // without auth -> 401
    const r401 = await app.request('/does-not-exist')
    expect(r401.status).toBe(401)
    // with auth -> 404
    const res = await app.request('/does-not-exist', {
      headers: { Authorization: 'Bearer sk-test' },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('not_found_error')
    process.env.AUTH_TOKENS = orig
  })
})
