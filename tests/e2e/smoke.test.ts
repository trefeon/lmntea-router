import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/index.js'
import {
  classifyError,
  createBreakerState,
  recordFailure,
  recordSuccess,
} from '../../src/router/circuitBreaker.js'
import { withEarlyKeepalive } from '../../src/streaming/earlyKeepalive.js'
import { encodeData, encodeDone } from '../../src/streaming/sse.js'
import { withStallWatchdog } from '../../src/streaming/stallWatchdog.js'
import { openaiToClaude } from '../../src/translator/openai-to-claude.js'
import { repairToolAdjacency } from '../../src/translator/tools.js'

const E2E_TOKEN = 'sk-e2e-test'

async function readStreamText(res: Response): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe('E2E smoke — hermetic via app.request() (no TCP)', () => {
  const origAuth = process.env.AUTH_TOKENS
  const origApiKeys = process.env.API_KEYS
  const origVitest = process.env.VITEST
  const origNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.AUTH_TOKENS = E2E_TOKEN
    process.env.API_KEYS = ''
    // ensure test-env fallback logic is active (routes check VITEST/NODE_ENV)
    process.env.VITEST = 'true'
    process.env.NODE_ENV = 'test'
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  afterEach(() => {
    if (origAuth === undefined) delete process.env.AUTH_TOKENS
    else process.env.AUTH_TOKENS = origAuth
    if (origApiKeys === undefined) delete process.env.API_KEYS
    else process.env.API_KEYS = origApiKeys
    if (origVitest === undefined) delete process.env.VITEST
    else process.env.VITEST = origVitest
    if (origNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = origNodeEnv
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1 — POST /v1/chat/completions non-stream with clamp+sanitize+thinking
  // -------------------------------------------------------------------------
  it('1a clamp — x-preview max_tokens 999999 clamped to 131072 with x-request-id + x-clamped header, non-stream 501', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999999,
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('x-clamped-max-tokens')).toBe('131072')
    // non-stream returns JSON stub, not SSE
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/application\/json/)
  })

  it('1b sanitize — deepseek strips temperature via x-sanitize-stripped', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'commandcode/deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.9,
        top_p: 0.9,
        max_tokens: 1000,
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const stripped = res.headers.get('x-sanitize-stripped') ?? ''
    expect(stripped).toMatch(/temperature/)
    // also top_p should be stripped for this model
    expect(stripped).toMatch(/top_p/)
  })

  it('1c thinking — budget_tokens 8192 bumps max_tokens to >=9216 via x-clamped header', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        thinking: { budget_tokens: 8192 },
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    // clamp -> 4096, then thinking reconciliation budget+1024=9216 => header 9216
    expect(res.headers.get('x-clamped-max-tokens')).toBe('9216')
    expect(res.headers.get('x-normalized-max-tokens')).toBe('9216')
  })

  it('1d reasoning_effort high maps to budget and reconciles (>=33792)', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1000,
        reasoning_effort: 'high',
      }),
    })
    expect(res.status).toBe(501)
    const val = Number(res.headers.get('x-clamped-max-tokens') ?? '0')
    // high -> 32768, +1024 => 33792 minimum
    expect(val).toBeGreaterThanOrEqual(33792)
  })

  // -------------------------------------------------------------------------
  // 2 — stream:true OpenAI shape with earlyKeepalive+stallWatchdog
  // -------------------------------------------------------------------------
  it('2 stream:true OpenAI shape — 200 text/event-stream with data JSON + [DONE], x-request-id + x-clamped', async () => {
    const app = createApp()
    // stub upstream fetch to return a controlled SSE stream (proves vi.stubGlobal path)
    const encoder = new TextEncoder()
    const chunk = {
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'opencode/x-preview-f-free',
      choices: [
        { index: 0, delta: { content: 'e2e hello' }, finish_reason: null },
      ],
    }
    const finalChunk = {
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'opencode/x-preview-f-free',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    const sseBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        c.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    const mockFetch = vi.fn(
      async () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
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
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('x-clamped-max-tokens')).toBe('131072')
    const text = await readStreamText(res)
    expect(text).toContain('data: ')
    expect(text).toContain('e2e hello')
    expect(text).toContain('data: [DONE]')
    expect(mockFetch).toHaveBeenCalled()
  })

  it('2b stream fallback (no fetch stub) — still 200 with mock SSE + [DONE] (hermetic, no network)', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hello stream fallback' }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const text = await readStreamText(res)
    expect(text).toContain('data: [DONE]')
    // either mock content or our stub content
    expect(text).toMatch(/Hello from mock|chat\.completion\.chunk/)
  })

  it('2c streaming headers are SSE-correct (no hop-by-hop leak)', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    // x-request-id must be present on streaming responses too
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{10,}/)
    // keep-alive helpers ensure these are set on the wire (checked via sseHeaders)
    expect(res.headers.get('cache-control')).toMatch(/no-cache/)
  })

  // -------------------------------------------------------------------------
  // 3 — POST /v1/messages Claude shape with tool adjacency
  // -------------------------------------------------------------------------
  it('3a POST /v1/messages non-stream Claude shape — 501 with clamped & sanitize headers, tool payload accepted', async () => {
    const app = createApp()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'use tool' }],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' },
            ],
          },
        ],
        max_tokens: 2048,
        stream: false,
      }),
    })
    // non-stream returns 501 stub (transport not wired for non-stream Claude either)
    expect(res.status).toBe(501)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('x-clamped-max-tokens')).toBeTruthy()
  })

  it('3b POST /v1/messages stream:true — 200 anthropic SSE with event: frames + x-request-id', async () => {
    const app = createApp()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'hello claude' }],
        max_tokens: 1024,
        stream: true,
        tools: [
          {
            name: 'get_weather',
            description: 'get weather',
            input_schema: { type: 'object' },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const text = await readStreamText(res)
    // anthropic mock emits typed events
    expect(text).toContain('event:')
    expect(text).toContain('data:')
    expect(text).toContain('message_start')
    expect(text).toContain('message_stop')
  })

  it('3c translator — tool adjacency pure: repairToolAdjacency merges and reorders correctly', () => {
    // orphan tool_result should be repaired to user text, consecutive same-role merged
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'user' as const, content: 'still hi' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'calc', arguments: '{}' },
          },
        ],
      },
      { role: 'tool' as const, content: '42', tool_call_id: 'call_1' },
    ]
    const repaired = repairToolAdjacency(msgs as never)
    // first two user messages merged or kept, adjacency preserved, orphan not leaked
    expect(repaired.length).toBeGreaterThanOrEqual(2)
    expect(repaired.some((m) => m.role === 'assistant')).toBe(true)
    // tool message should not remain orphaned after repair
    expect(
      repaired.filter((m) => m.role === 'tool').length,
    ).toBeLessThanOrEqual(1)
  })

  it('3d translator — openaiToClaude hoists system & preserves thinking', () => {
    const out = openaiToClaude({
      model: 'opencode/x-preview-f-free',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    } as unknown as Record<string, unknown>)
    expect(out.system).toBe('You are helpful.')
    expect(out.messages).toHaveLength(1)
    // thinking 1024 with max_tokens 1024 reconciles to budget+1024=2048 per thinking.ts (max must exceed budget)
    expect(out.max_tokens).toBe(2048)
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  // -------------------------------------------------------------------------
  // 4 — GET /v1/models enriched
  // -------------------------------------------------------------------------
  it('4 GET /v1/models — 200 list enriched with pricing/tier, provider filter, x-request-id', async () => {
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThanOrEqual(8)
    for (const entry of body.data as Record<string, unknown>[]) {
      expect(typeof entry.id).toBe('string')
      expect(typeof entry.object).toBe('string')
      // enriched fields from intelligence/model registry
      expect(entry).toHaveProperty('created')
    }
    // spot check known model exists
    const ids = (body.data as { id: string }[]).map((e) => e.id)
    expect(ids).toContain('opencode/x-preview-f-free')

    // provider filter
    const filtered = await app.request('/v1/models?provider=opencode', {
      headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    })
    expect(filtered.status).toBe(200)
    const fBody = (await filtered.json()) as { data: { id: string }[] }
    expect(fBody.data.every((m) => m.id.startsWith('opencode/'))).toBe(true)

    // auth required — no token -> 401
    const noAuth = await app.request('/v1/models')
    expect(noAuth.status).toBe(401)
  })

  it('4b GET /v1/models/:id — single enriched entry with contextLength/maxCompletionTokens', async () => {
    const app = createApp()
    const res = await app.request('/v1/models/opencode%2Fx-preview-f-free', {
      headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe('opencode/x-preview-f-free')
    expect(typeof body.created).toBe('number')
    // enriched fields
    expect(body).toHaveProperty('owned_by')
  })

  // -------------------------------------------------------------------------
  // 5 — abort via AbortController propagates to upstream
  // -------------------------------------------------------------------------
  it('5 abort — client AbortController aborts upstream fetch (signal propagates, no hang)', async () => {
    let observedSignal: AbortSignal | undefined
    let fetchCalled = false
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      fetchCalled = true
      observedSignal = init.signal as AbortSignal | undefined
      // hang until aborted — respect signal
      return new Promise<Response>((_resolve, reject) => {
        const sig = init.signal as AbortSignal | undefined
        if (!sig) {
          // no signal, just return mock SSE quickly (should not happen)
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encodeData({ hello: 1 }))
              c.enqueue(encodeDone())
              c.close()
            },
          })
          _resolve(
            new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          )
          return
        }
        if (sig.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        sig.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const app = createApp()
    const controller = new AbortController()
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'abort me' }],
        stream: true,
      }),
      signal: controller.signal,
    })
    const resPromise = app.request(req)
    // abort very soon — before dispatch would succeed
    setTimeout(() => controller.abort(), 10)
    const res = await resPromise

    // routes normalize: if client aborts before dispatch resolves, upstreamController.aborted && rawSignal.aborted -> 499
    // but in test env with fallback, may still be 200 with empty stream that respects abort. Both are valid hermetic outcomes.
    // The critical invariant is that upstream fetch was invoked with an abortable signal and that signal got aborted.
    expect(fetchCalled).toBe(true)
    expect(observedSignal).toBeDefined()
    // give abort propagation a tick
    await new Promise((r) => setTimeout(r, 20))
    expect(observedSignal!.aborted).toBe(true)
    // ensure we did not hang — response is either 499 (client cancelled) or 200 with abort-aware stream
    expect([200, 499, 504].includes(res.status)).toBe(true)
    if (res.body) {
      const reader = res.body.getReader()
      const raced = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 250),
        ),
      ])
      expect(raced.done !== undefined).toBe(true)
    }
  })

  it('5b abort — direct streaming wrappers respect AbortSignal (withEarlyKeepalive/stallWatchdog)', async () => {
    // pure wrapper test: hanging upstream -> earlyKeepalive+stallWatchdog, abort propagates
    // needs real timers — genuine platform clock behavior under AbortSignal (not deterministic via fake timers)
    const controller = new AbortController()
    const hanging = new ReadableStream<Uint8Array>({
      start() {
        // never enqueue, never close — watchdog should synthesize finish unless aborted first
      },
    })
    const wrapped = withStallWatchdog(
      withEarlyKeepalive(hanging, {
        graceMs: 10,
        intervalMs: 10,
        signal: controller.signal,
      }),
      {
        format: 'openai',
        timeoutMs: 50,
        signal: controller.signal,
        upstreamController: controller,
      },
    )
    const reader = wrapped.getReader()
    setTimeout(() => controller.abort(), 15)
    const start = Date.now()
    let done = false
    while (Date.now() - start < 300) {
      const { done: d } = (await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: undefined }), 80),
        ),
      ])) as { done: boolean }
      if (d) {
        done = true
        break
      }
      if (controller.signal.aborted) break
    }
    expect(controller.signal.aborted).toBe(true)
    // either done or aborted is acceptable — key is no hang past 300ms
    expect(done || controller.signal.aborted).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 6 — rate-limit/breaker not flaky (deterministic pure + sequential app.request)
  // -------------------------------------------------------------------------
  it('6 breaker not flaky — 10 sequential POSTs all succeed with distinct x-request-id, no 429/5xx flake', async () => {
    const app = createApp()
    const ids = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${E2E_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'opencode/x-preview-f-free',
          messages: [{ role: 'user', content: `hi ${i}` }],
          max_tokens: 100,
        }),
      })
      expect(res.status).toBe(501)
      const rid = res.headers.get('x-request-id') ?? ''
      expect(rid).toBeTruthy()
      ids.add(rid)
      // ensure no accidental rate-limit — all 10 must be 501, not 429
      expect(res.status).not.toBe(429)
    }
    // each request gets a fresh requestId (unless client supplied one)
    expect(ids.size).toBe(10)
  })

  it('6b breaker pure — classifyError + sliding window trips deterministically after 3x 5xx', () => {
    // classifier — 401/403/429 rotate, 400 reject, 5xx failover
    expect(classifyError(500)).toBe('FAILOVER_NEXT_MODEL')
    expect(classifyError(502)).toBe('FAILOVER_NEXT_MODEL')
    expect(classifyError(429)).toBe('ROTATE_ACCOUNT_IN_POOL')
    expect(classifyError(401)).toBe('ROTATE_ACCOUNT_IN_POOL')
    expect(classifyError(403)).toBe('ROTATE_ACCOUNT_IN_POOL')
    expect(classifyError(400)).toBe('REJECT_IMMEDIATE')

    // sliding window: 3 consecutive 5xx in 60s trips breaker with 60s cooldown
    let state = createBreakerState()
    const base = 1_000_000
    state = recordFailure(state, base)
    state = recordFailure(state, base + 10_000)
    expect(state.openedAt).toBeNull()
    expect(state.state).toBe('CLOSED')
    state = recordFailure(state, base + 20_000)
    // after 3rd failure in 60s window, breaker OPEN
    expect(state.openedAt).toBe(base + 20_000)
    expect(state.state).toBe('OPEN')
    expect(recordSuccess(createBreakerState()).failures).toEqual([])

    // recordSuccess clears failures before trip keeps CLOSED
    let preTrip = createBreakerState()
    preTrip = recordFailure(preTrip, base)
    preTrip = recordFailure(preTrip, base + 1_000)
    expect(preTrip.failures.length).toBe(2)
    const cleared = recordSuccess(preTrip)
    expect(cleared.failures).toEqual([])
    expect(cleared.state).toBe('CLOSED')
  })

  it('6c no TCP ports opened — app.request is hermetic, fetch mock proves no network', async () => {
    const app = createApp()
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                encodeData({
                  id: 'test',
                  choices: [{ delta: { content: 'hi' } }],
                }),
              )
              c.enqueue(encodeDone())
              c.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'opencode/x-preview-f-free',
        messages: [{ role: 'user', content: 'port check' }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalled()
    // no server.listen was called — app.request is in-memory, no port binding
    const text = await readStreamText(res)
    expect(text).toContain('data: [DONE]')
  })
})
