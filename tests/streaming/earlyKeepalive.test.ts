import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EARLY_KEEPALIVE_GRACE_MS,
  EARLY_KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_BYTES,
  earlyKeepaliveHeaders,
  withEarlyKeepalive,
  withEarlyKeepaliveResponse,
  wrapWithEarlyKeepalive,
} from '../../src/streaming/earlyKeepalive.js'
import { sseHeaders } from '../../src/streaming/sse.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function chunk(text: string): Uint8Array {
  return enc.encode(text)
}

function toText(c: Uint8Array): string {
  return dec.decode(c)
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  const reader = stream.getReader()
  const out: string[] = []
  const deadline = opts?.timeoutMs ?? 5000
  const start = Date.now()
  while (true) {
    if (Date.now() - start > deadline) break
    const { done, value } = await reader.read()
    if (done) break
    if (value) out.push(toText(value))
    // allow timer callbacks between reads
    await Promise.resolve()
  }
  return out
}

function createControlledUpstream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    enqueue(text: string) {
      controller?.enqueue(chunk(text))
    },
    close() {
      try {
        controller?.close()
      } catch {}
    },
    error(e: unknown) {
      try {
        controller?.error(e)
      } catch {}
    },
    get controller() {
      return controller
    },
  }
}

describe('earlyKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exports withEarlyKeepalive and constants with correct defaults', () => {
    expect(typeof withEarlyKeepalive).toBe('function')
    expect(EARLY_KEEPALIVE_GRACE_MS).toBe(2000)
    expect(EARLY_KEEPALIVE_INTERVAL_MS).toBe(3000)
    expect(toText(KEEPALIVE_BYTES)).toBe(': keepalive\n\n')
  })

  it('no delay — fast stream emits no keepalive', async () => {
    const upstream = createControlledUpstream()
    const wrapped = wrapWithEarlyKeepalive(upstream.stream, {
      graceMs: 2000,
      intervalMs: 3000,
    })

    const reader = wrapped.getReader()

    // enqueue quickly before grace fires
    upstream.enqueue('data: hello\n\n')
    upstream.close()

    // let transform flush
    await vi.advanceTimersByTimeAsync(10)

    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(toText(first.value!)).toBe('data: hello\n\n')

    const second = await reader.read()
    expect(second.done).toBe(true)

    // advancing past grace should not have produced keepalive after close
    await vi.advanceTimersByTimeAsync(5000)
    const third = await reader.read()
    expect(third.done).toBe(true)
  })

  it('delayed — emits : keepalive at grace and every interval until real data', async () => {
    const upstream = createControlledUpstream()
    const wrapped = wrapWithEarlyKeepalive(upstream.stream, {
      graceMs: 2000,
      intervalMs: 3000,
    })

    const reader = wrapped.getReader()

    // no data yet — advance to grace, should see first keepalive
    const pendingFirst = reader.read()
    await vi.advanceTimersByTimeAsync(2000)
    const first = await pendingFirst
    expect(first.done).toBe(false)
    expect(toText(first.value!)).toBe(': keepalive\n\n')

    // next interval at 5000 total (2000+3000)
    const pendingSecond = reader.read()
    await vi.advanceTimersByTimeAsync(3000)
    const second = await pendingSecond
    expect(second.done).toBe(false)
    expect(toText(second.value!)).toBe(': keepalive\n\n')

    // now upstream finally produces data — should cancel keepalive and forward verbatim
    upstream.enqueue('data: real\n\n')
    const third = await reader.read()
    expect(toText(third.value!)).toBe('data: real\n\n')

    // further intervals should not emit after first real chunk
    await vi.advanceTimersByTimeAsync(5000)
    upstream.enqueue('data: second\n\n')
    const fourth = await reader.read()
    expect(toText(fourth.value!)).toBe('data: second\n\n')

    upstream.close()
    const done = await reader.read()
    expect(done.done).toBe(true)
  })

  it('abort — client signal aborts before first chunk, stops keepalive and cancels upstream', async () => {
    const upstream = createControlledUpstream()
    const controller = new AbortController()

    const wrapped = wrapWithEarlyKeepalive(upstream.stream, {
      graceMs: 2000,
      intervalMs: 3000,
      signal: controller.signal,
    })

    const reader = wrapped.getReader()

    // trigger first keepalive
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(2000)
    const first = await pending
    expect(toText(first.value!)).toBe(': keepalive\n\n')

    // abort client before upstream data
    controller.abort(new DOMException('client aborted', 'AbortError'))

    // allow abort propagation
    await vi.advanceTimersByTimeAsync(10)

    // wrapped should be done (close) not error
    const afterAbort = await reader.read()
    expect(afterAbort.done).toBe(true)

    // advancing further should not emit keepalive
    await vi.advanceTimersByTimeAsync(5000)
    const later = await reader.read()
    expect(later.done).toBe(true)

    // upstream should be cancelled — trying to enqueue should be ignored / error suppressed
    upstream.enqueue('data: late\n\n')
    await vi.advanceTimersByTimeAsync(10)
    const final = await reader.read()
    expect(final.done).toBe(true)
  })

  it('header preservation — withEarlyKeepaliveResponse fast path preserves upstream headers', async () => {
    const upstreamPromise = Promise.resolve(
      new Response(chunk('data: fast\n\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Custom': 'preserve-me',
        },
      }),
    )

    const result = await withEarlyKeepaliveResponse(upstreamPromise, {
      graceMs: 2000,
      intervalMs: 3000,
    })

    expect(result.status).toBe(200)
    expect(result.headers.get('Content-Type')).toBe('text/event-stream')
    expect(result.headers.get('X-Custom')).toBe('preserve-me')
    // collect body to ensure no keepalive inserted
    const text = await result.text()
    expect(text).toBe('data: fast\n\n')
  })

  it('header preservation — slow path flushes 200 text/event-stream + keepalive headers', async () => {
    const upstreamPromise = new Promise<Response>((resolve) => {
      setTimeout(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(chunk('data: hello\n\n'))
            c.enqueue(chunk('data: [DONE]\n\n'))
            c.close()
          },
        })
        resolve(
          new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        )
      }, 5000)
    })

    const responsePromise = withEarlyKeepaliveResponse(upstreamPromise, {
      graceMs: 2000,
      intervalMs: 3000,
    })

    // advance to grace — should commit to slow path
    await vi.advanceTimersByTimeAsync(2000)
    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(response.headers.get('Connection')).toBe('keep-alive')
    // earlyKeepaliveHeaders helper consistency
    const expected = earlyKeepaliveHeaders()
    expect(response.headers.get('Content-Type')).toBe(expected['Content-Type'])

    const reader = response.body!.getReader()

    const first = await reader.read()
    expect(toText(first.value!)).toBe(': keepalive\n\n')

    await vi.advanceTimersByTimeAsync(3000)
    const second = await reader.read()
    expect(toText(second.value!)).toBe(': keepalive\n\n')

    // advance to upstream resolve at 5000 total
    await vi.advanceTimersByTimeAsync(2000)
    const third = await reader.read()
    expect(toText(third.value!)).toBe('data: hello\n\n')

    const fourth = await reader.read()
    expect(toText(fourth.value!)).toBe('data: [DONE]\n\n')

    const done = await reader.read()
    expect(done.done).toBe(true)
  })

  it('hermetic Hono — app.request wraps upstream via withEarlyKeepalive without TCP', async () => {
    const app = new Hono()

    app.get('/stream', async (c) => {
      // Simulate slow upstream — 4s delay before headers
      const upstreamPromise = new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(ctrl) {
                  ctrl.enqueue(chunk('data: hono-hello\n\n'))
                  ctrl.enqueue(chunk('data: [DONE]\n\n'))
                  ctrl.close()
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            ),
          )
        }, 4000)
      })

      const resp = await withEarlyKeepalive(upstreamPromise as Promise<Response>, {
        graceMs: 2000,
        intervalMs: 3000,
        signal: c.req.raw.signal,
      })
      return resp
    })

    // fire request without real TCP
    const requestPromise = app.request('/stream')

    await vi.advanceTimersByTimeAsync(2000)
    const res = await requestPromise
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    expect(res.headers.get('Connection')).toBe('keep-alive')

    const reader = res.body!.getReader()

    const first = await reader.read()
    expect(toText(first.value!)).toBe(': keepalive\n\n')

    await vi.advanceTimersByTimeAsync(2000)
    // at 4000 total upstream resolves, next read is data
    const second = await reader.read()
    // Depending on timing, second may be keepalive at 5000 or data at 4000 —
    // our interval is 3000, so next keepalive would be at 5000,
    // but upstream data arrives at 4000, so we should get data next
    // advance exactly to 4000 from start (already at 2000, need 2000 more)
    // The second read after 2000 advance should be data
    expect(toText(second.value!)).toContain('hono-hello')
  })

  it('pure wrapper — does not mutate original stream chunks', async () => {
    const originalChunks = ['data: a\n\n', 'data: b\n\n']
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const txt of originalChunks) c.enqueue(chunk(txt))
        c.close()
      },
    })

    // capture original chunks by tee before wrapping? Instead, verify wrapped output equals original when no delay
    const wrapped = wrapWithEarlyKeepalive(upstream, {
      graceMs: 2000,
      intervalMs: 3000,
    })

    // need to collect wrapped - should match original exactly since no keepalive triggered
    await vi.advanceTimersByTimeAsync(10)
    const collected = await collect(wrapped)
    expect(collected).toEqual(originalChunks)
  })

  it('custom comment and keepaliveFrame override', async () => {
    const upstream = createControlledUpstream()
    const custom = ': custom-ping\n\n'
    const wrapped = wrapWithEarlyKeepalive(upstream.stream, {
      graceMs: 1000,
      intervalMs: 1000,
      keepaliveFrame: custom,
    })

    const reader = wrapped.getReader()
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(1000)
    const first = await pending
    expect(toText(first.value!)).toBe(custom)

    upstream.enqueue('data: x\n\n')
    const second = await reader.read()
    expect(toText(second.value!)).toBe('data: x\n\n')
    upstream.close()
  })

  it('earlyKeepaliveHeaders and sseHeaders agree on SSE essentials', () => {
    const a = earlyKeepaliveHeaders({ 'X-Test': '1' })
    const b = sseHeaders({ 'X-Test': '1' })
    expect(a['Content-Type']).toBe('text/event-stream')
    expect(b['Content-Type']).toBe('text/event-stream')
    expect(a['Cache-Control']).toBe('no-cache')
    expect(b['Cache-Control']).toContain('no-cache')
    expect(a.Connection).toBe('keep-alive')
    expect(b.Connection).toBe('keep-alive')
    expect(a['X-Test']).toBe('1')
  })

  it('withEarlyKeepalive overload — stream returns stream synchronously', async () => {
    const upstream = createControlledUpstream()
    const result = withEarlyKeepalive(upstream.stream, { graceMs: 2000 })
    expect(result).toBeInstanceOf(ReadableStream)
    upstream.enqueue('data: sync\n\n')
    upstream.close()
    await vi.advanceTimersByTimeAsync(10)
    const reader = (result as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(toText(first.value!)).toBe('data: sync\n\n')
  })

  it('abort before grace — no keepalive emitted', async () => {
    const upstream = createControlledUpstream()
    const controller = new AbortController()
    controller.abort()
    const wrapped = wrapWithEarlyKeepalive(upstream.stream, {
      graceMs: 2000,
      intervalMs: 3000,
      signal: controller.signal,
    })
    const reader = wrapped.getReader()
    await vi.advanceTimersByTimeAsync(5000)
    const result = await reader.read()
    expect(result.done).toBe(true)
  })
