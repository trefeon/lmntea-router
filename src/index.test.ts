import { describe, expect, it } from 'vitest'
import { createApp } from './index.js'

describe('GET /health via src (legacy, mirrors tests/health.test.ts)', () => {
  it('returns 200 {status:"ok", uptime, version}', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; version: string }
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
  })
})
