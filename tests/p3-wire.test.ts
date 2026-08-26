import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/index.js'
import { clampBody, clampMaxTokens } from '../src/normalizer/clamp.js'
import { COOLDOWN_MS, TRIP_THRESHOLD } from '../src/router/circuitBreaker.js'
import { __resetBreakerStatesForTests } from '../src/routes/chat.js'

describe('P3 — wire P2 normalizer into routes (p3-wire)', () => {
  const origAuth = process.env.AUTH_TOKENS
  const origApiKeys = process.env.API_KEYS

  beforeEach(() => {
    process.env.AUTH_TOKENS = 'sk-test'
    process.env.API_KEYS = ''
  })
  afterEach(() => {
    process.env.AUTH_TOKENS = origAuth
    process.env.API_KEYS = origApiKeys
  })

  it('clampMaxTokens alias exists and equals clampBody', () => {
    expect(typeof clampMaxTokens).toBe('function')
    expect(clampMaxTokens).toBe(clampBody)
  })

  it('POST /v1/chat/completions x-preview max_tokens 999999 clamped to 131072 via header', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999999,
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-clamped-max-tokens')).toBe('131072')
  })

  it('POST /v1/chat/completions deepseek strips temperature via x-sanitize-stripped', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'commandcode/deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5000,
        temperature: 0.9,
        top_p: 0.9,
      }),
    })
    expect(res.status).toBe(501)
    const stripped = res.headers.get('x-sanitize-stripped') ?? ''
    expect(stripped).toMatch(/temperature/)
  })

  it('POST /v1/messages x-preview max_tokens 999999 clamped to 131072', async () => {
    const app = createApp()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999999,
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-clamped-max-tokens')).toBe('131072')
  })

  it('thinking reconciliation bumps max_tokens when budget > requested', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        thinking: { budget_tokens: 8192 },
      }),
    })
    expect(res.status).toBe(501)
    const clamped = res.headers.get('x-clamped-max-tokens')
    // budget 8192 + 1024 = 9216, so header should be 9216 (clamp then reconcile)
    expect(clamped).toBe('9216')
  })

  it('reasoning_effort high maps to budget and reconciles', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1000,
        reasoning_effort: 'high',
      }),
    })
    expect(res.status).toBe(501)
    const val = Number(res.headers.get('x-clamped-max-tokens'))
    // high -> 32768, +1024 => 33792, reconciled value must be >= 33792
    expect(val).toBeGreaterThanOrEqual(33792)
  })

  it('stream:true still runs normalizer and returns x-clamped header', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999999,
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    // stream also sets clamped header before returning (P4 engine)
    expect(res.headers.get('x-clamped-max-tokens')).toBe('131072')
  })

  it('breaker blocks second upstream dispatch within cooldown (fake timers)', async () => {
    vi.useFakeTimers()
    __resetBreakerStatesForTests()
    // fresh failing Response per call — route consumes error bodies on failover
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    try {
      const app = createApp()
      const fire = () =>
        app.request('/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'opencode/x-preview-f-free',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 64,
            stream: true,
          }),
        })

      // TRIP_THRESHOLD consecutive 5xx responses trip the provider breaker
      for (let i = 0; i < TRIP_THRESHOLD; i++) {
        const pending = fire()
        await vi.advanceTimersByTimeAsync(0)
        const res = await pending
        // test runtime still serves the hermetic mock stream on exhaustion
        expect(res.status).toBe(200)
        await res.text()
      }
      expect(fetchMock).toHaveBeenCalledTimes(TRIP_THRESHOLD)

      // next request within cooldown: breaker OPEN → dispatch skipped entirely
      const blocked = fire()
      await vi.advanceTimersByTimeAsync(0)
      const resBlocked = await blocked
      expect(fetchMock).toHaveBeenCalledTimes(TRIP_THRESHOLD)
      expect(resBlocked.headers.get('x-router-action')).toContain(
        'breaker_skip:opencode',
      )
      await resBlocked.text()

      // after cooldown elapses the breaker half-opens and attempts again
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1)
      const recovered = fire()
      await vi.advanceTimersByTimeAsync(0)
      const resRecovered = await recovered
      expect(fetchMock).toHaveBeenCalledTimes(TRIP_THRESHOLD + 1)
      await resRecovered.text()
    } finally {
      __resetBreakerStatesForTests()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
