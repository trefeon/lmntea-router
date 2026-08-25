import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STALL_TIMEOUT_MS,
  StallWatchdog,
  createAnthropicStallChunks,
  createOpenAIStallChunk,
  withStallWatchdog,
} from '../../src/streaming/stallWatchdog.js'

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
    // guard against hanging streams in real timers
    if (Date.now() - start > deadline) break
    const { value, done } = await reader.read()
    if (done) break
    if (value) out.push(toText(value))
  }
  return out
}

// Helper: create a controlled upstream where we can push chunks manually
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
      controller!.enqueue(chunk(text))
    },
    close() {
      controller!.close()
    },
    error(e: unknown) {
      controller!.error(e)
    },
    get controller() {
      return controller!
    },
  }
}

describe('StallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exports StallWatchdog class/fn and default timeout is 60s', () => {
    expect(StallWatchdog).toBeDefined()
    expect(typeof StallWatchdog).toBe('function')
    expect(STALL_TIMEOUT_MS).toBe(60_000)
    expect(new StallWatchdog().timeoutMs).toBe(60_000)
    expect(new StallWatchdog({ timeoutMs: 123 }).timeoutMs).toBe(123)
  })

  it('throws on non-positive timeout', () => {
    expect(() => new StallWatchdog({ timeoutMs: 0 as number })).toThrow(
      RangeError,
    )
    expect(() => new StallWatchdog({ timeoutMs: -1 })).toThrow(RangeError)
  })

  it('no stall — fast stream completes before timeout, no synthetic', async () => {
    const upstream = createControlledUpstream()
    const wd = new StallWatchdog({ timeoutMs: 60_000, format: 'openai' })
    const watched = wd.wrap(upstream.stream)

    const reader = watched.getReader()
    // enqueue quickly before timeout
    upstream.enqueue('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    upstream.close()

    // allow microtasks to flush transform
    await vi.advanceTimersByTimeAsync(10)
    // collect after close — should NOT have triggered stall even after advancing 60s
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(toText(first.value!)).toContain('hi')

    const second = await reader.read()
    expect(second.done).toBe(true)

    // advancing 60s after close must not emit synthetic
    await vi.advanceTimersByTimeAsync(60_000)
    const third = await reader.read()
    expect(third.done).toBe(true)
  })

  it('stall triggers — openai format emits finish_reason:stop + [DONE] and closes gracefully', async () => {
    const upstream = createControlledUpstream()
    const upstreamController = new AbortController()
    let stalled = false
    const wd = new StallWatchdog({
      timeoutMs: 60_000,
      format: 'openai',
      upstreamController,
      onStall: () => {
        stalled = true
      },
    })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()

    // first chunk resets timer
    upstream.enqueue('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
    const a = await reader.read()
    expect(toText(a.value!)).toContain('hello')

    // stall 59s — not yet
    await vi.advanceTimersByTimeAsync(59_000)
    // stream should still be open (next read would hang); we can check byracing with timeout
    // Instead advance one more second to trigger stall
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(1_000)
    const stalledChunk = await pending
    expect(stalled).toBe(true)
    const text = toText(stalledChunk.value!)
    expect(text).toContain('finish_reason')
    expect(text).toContain('"stop"')
    expect(text).toContain('[DONE]')
    expect(upstreamController.signal.aborted).toBe(true)

    // after stall, stream should be done
    const done = await reader.read()
    expect(done.done).toBe(true)
  })

  it('reset — each chunk resets 60s timer, stall only after idle', async () => {
    const upstream = createControlledUpstream()
    const wd = new StallWatchdog({ timeoutMs: 60_000, format: 'openai' })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()

    upstream.enqueue('chunk1\n')
    expect(toText((await reader.read()).value!)).toContain('chunk1')

    await vi.advanceTimersByTimeAsync(30_000)
    upstream.enqueue('chunk2\n')
    expect(toText((await reader.read()).value!)).toContain('chunk2')

    await vi.advanceTimersByTimeAsync(30_000) // 30s after chunk2, still not stalled (needs 60s idle)
    upstream.enqueue('chunk3\n')
    expect(toText((await reader.read()).value!)).toContain('chunk3')

    // now idle 60s after chunk3 -> stall
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(60_000)
    const stalled = await pending
    expect(toText(stalled.value!)).toContain('[DONE]')
  })

  it('abort — client signal aborts upstream and closes stream without synthetic', async () => {
    const upstream = createControlledUpstream()
    const clientController = new AbortController()
    const upstreamController = new AbortController()
    const wd = new StallWatchdog({
      timeoutMs: 60_000,
      format: 'openai',
      signal: clientController.signal,
      upstreamController,
    })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()

    upstream.enqueue('data: hi\n\n')
    expect(toText((await reader.read()).value!)).toContain('hi')

    // client disconnect
    clientController.abort(new DOMException('client close', 'AbortError'))
    // allow abort microtask + terminate
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(upstreamController.signal.aborted).toBe(true)
    // stream terminated gracefully (done:true), no synthetic finish_reason
    const after = await reader.read()
    expect(after.done).toBe(true)
    if (after.value) {
      expect(toText(after.value)).not.toContain('finish_reason')
    }
    // advancing timers must not produce synthetic after abort
    await vi.advanceTimersByTimeAsync(60_000)
    const stillDone = await reader.read()
    expect(stillDone.done).toBe(true)
  })

  it('graceful finish — normal close clears timer, no stall after completion', async () => {
    const upstream = createControlledUpstream()
    let stalled = false
    const wd = new StallWatchdog({
      timeoutMs: 100, // short for hermetic sanity, but also test 60s path via fake timers
      format: 'openai',
      onStall: () => {
        stalled = true
      },
    })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()

    upstream.enqueue('hello\n')
    upstream.close()
    // flush should close and clear timer
    const v1 = await reader.read()
    expect(toText(v1.value!)).toContain('hello')
    const v2 = await reader.read()
    expect(v2.done).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(stalled).toBe(false)
    expect((await reader.read()).done).toBe(true)
  })

  it('anthropic format — stall emits message_delta + message_stop', async () => {
    const upstream = createControlledUpstream()
    const wd = new StallWatchdog({ timeoutMs: 60_000, format: 'anthropic' })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()

    upstream.enqueue(
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
    )
    expect(toText((await reader.read()).value!)).toContain(
      'content_block_delta',
    )

    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(60_000)
    const firstSynth = await pending
    let combined = toText(firstSynth.value!)
    expect(combined).toContain('message_delta')
    // anthropic synthesis is two enqueues: message_delta then message_stop may arrive as one or two reads
    if (!combined.includes('message_stop')) {
      const secondSynth = await reader.read()
      expect(secondSynth.done).toBe(false)
      combined += toText(secondSynth.value!)
      expect(combined).toContain('message_stop')
    } else {
      expect(combined).toContain('message_stop')
    }
    expect((await reader.read()).done).toBe(true)
  })

  it('withStallWatchdog functional wrapper behaves same as class', async () => {
    const upstream = createControlledUpstream()
    const watched = withStallWatchdog(upstream.stream, {
      timeoutMs: 60_000,
      format: 'openai',
    })
    const reader = watched.getReader()
    upstream.enqueue('a\n')
    expect(toText((await reader.read()).value!)).toContain('a')
    upstream.close()
    await vi.advanceTimersByTimeAsync(0)
    // after upstream close, watchdog flush clears timer and closes — next read should be done
    const done = await reader.read()
    expect(done.done).toBe(true)
  })

  it('createOpenAIStallChunk and createAnthropicStallChunks produce valid SSE', () => {
    const open = toText(createOpenAIStallChunk())
    expect(open).toContain('data: ')
    expect(open).toContain('finish_reason')
    expect(open).toContain('"stop"')
    expect(open).toContain('data: [DONE]')

    const anth = createAnthropicStallChunks().map(toText).join('')
    expect(anth).toContain('event: message_delta')
    expect(anth).toContain('event: message_stop')
    expect(anth).toContain('stop_reason')
  })

  it('upstream already aborted signal + immediate client abort handled', async () => {
    const upstream = createControlledUpstream()
    const clientController = new AbortController()
    clientController.abort()
    const upstreamController = new AbortController()
    const wd = new StallWatchdog({
      timeoutMs: 60_000,
      signal: clientController.signal,
      upstreamController,
    })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()
    await vi.advanceTimersByTimeAsync(0)
    // should be terminated immediately, no hang
    const r = await reader.read()
    expect(r.done).toBe(true)
    expect(upstreamController.signal.aborted).toBe(true)
  })

  it('onStall throwing does not break synthetic emission', async () => {
    const upstream = createControlledUpstream()
    const wd = new StallWatchdog({
      timeoutMs: 50,
      format: 'openai',
      onStall: () => {
        throw new Error('oops')
      },
    })
    const watched = wd.wrap(upstream.stream)
    const reader = watched.getReader()
    upstream.enqueue('hi\n')
    await reader.read()
    const pending = reader.read()
    await vi.advanceTimersByTimeAsync(50)
    const v = await pending
    expect(toText(v.value!)).toContain('[DONE]')
  })
})
