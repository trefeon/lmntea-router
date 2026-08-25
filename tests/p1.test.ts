import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'

const VALID = 'sk-test'
const OTHER = 'sk-other'

describe('P1 — Ingress & Auth (legacy p1.test.ts, now 501/422)', () => {
  const orig = process.env.AUTH_TOKENS

  beforeEach(() => {
    process.env.AUTH_TOKENS = `${VALID},${OTHER}`
  })
  afterEach(() => {
    process.env.AUTH_TOKENS = orig
  })

  it('GET /health is public (no auth)', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })

  it('GET /v1/models without auth → 401', async () => {
    const app = createApp()
    const res = await app.request('/v1/models')
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({
      error: { type: 'authentication_error' },
    })
  })

  it('GET /v1/models with Authorization: Bearer valid → 200', async () => {
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      data: Array<{ id: string }>
    }
    expect(body.object).toBe('list')
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain('opencode/x-preview-f-free')
    expect(ids).toContain('opencode/muse-spark-1.2-contributor-free')
  })
  it('GET /v1/models with x-api-key valid → 200', async () => {
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { 'x-api-key': VALID },
    })
    expect(res.status).toBe(200)
  })

  it('GET /v1/models with anthropic-api-key valid → 200', async () => {
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { 'anthropic-api-key': VALID },
    })
    expect(res.status).toBe(200)
  })

  it('POST /v1/chat/completions without Content-Type → 415', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID}` },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(415)
  })

  it('POST /v1/chat/completions invalid JSON → 422', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'Content-Type': 'application/json',
      },
      body: '{not json',
    })
    expect(res.status).toBe(422)
  })

  it('POST /v1/chat/completions missing model → 422', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { param: string } }
    expect(body.error.param).toBe('model')
  })

  it('POST /v1/chat/completions valid → 501 stub', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('POST /v1/chat/completions stream → 200 text/event-stream with [DONE] (P4)', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await res.text()
    expect(text).toContain('data: [DONE]')
  })

  it('POST /v1/messages valid → 501 stub', async () => {
    const app = createApp()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': VALID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    })
    expect(res.status).toBe(501)
  })

  it('hermetic: AUTH_TOKENS empty → all v1 allow without header', async () => {
    process.env.AUTH_TOKENS = ''
    const app = createApp()
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(chat.status).toBe(501)
  })
})
