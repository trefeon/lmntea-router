import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'
import { resetUsageForTests } from '../src/observability/usage.js'

const originalAuth = process.env.AUTH_TOKENS

beforeEach(() => {
  process.env.AUTH_TOKENS = ''
  resetUsageForTests()
})

afterAll(() => {
  if (originalAuth === undefined) delete process.env.AUTH_TOKENS
  else process.env.AUTH_TOKENS = originalAuth
})

describe('GET /v1/usage', () => {
  it('returns an empty summary for a fresh process', async () => {
    const app = createApp()
    const res = await app.request('/v1/usage?period=24h')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    await expect(res.json()).resolves.toEqual({
      requests: 0,
      errors: 0,
      tokensIn: null,
      tokensOut: null,
      cost: null,
      avgLatencyMs: null,
      avgTtftMs: null,
      p95Ms: null,
      cacheHit: null,
      points: [],
      byModel: [],
    })
  })

  it('rejects a missing or unsupported period with a validation envelope', async () => {
    const app = createApp()

    const missing = await app.request('/v1/usage')
    expect(missing.status).toBe(422)
    await expect(missing.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'INVALID_REQUEST',
        param: 'period',
      },
    })

    const unsupported = await app.request('/v1/usage?period=90d')
    expect(unsupported.status).toBe(422)
    await expect(unsupported.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'INVALID_REQUEST',
        param: 'period',
      },
    })
  })

  it('inherits the v1 authentication boundary', async () => {
    process.env.AUTH_TOKENS = 'sk-usage-test'
    const app = createApp()

    const unauthenticated = await app.request('/v1/usage?period=24h')
    expect(unauthenticated.status).toBe(401)

    const authenticated = await app.request('/v1/usage?period=24h', {
      headers: { Authorization: 'Bearer sk-usage-test' },
    })
    expect(authenticated.status).toBe(200)
  })
})

describe('request recording', () => {
  it('records Chat Completions and Messages outcomes by model', async () => {
    const app = createApp()

    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oc/x-preview-f-free',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })
    expect(chat.status).toBe(200)
    await chat.text()

    const messages = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      }),
    })
    expect(messages.status).toBe(501)

    const usage = await app.request('/v1/usage?period=24h')
    expect(usage.status).toBe(200)
    await expect(usage.json()).resolves.toMatchObject({
      requests: 2,
      errors: 1,
      byModel: expect.arrayContaining([
        expect.objectContaining({ model: 'oc/x-preview-f-free', req: 1 }),
        expect.objectContaining({ model: 'anthropic/claude-fable-5', req: 1 }),
      ]),
    })
  })
})
