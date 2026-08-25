/**
 * stallWatchdog.ts — 60s reset-on-chunk watchdog
 *
 * Pure Web Streams implementation, no I/O leak.
 * Wraps an upstream ReadableStream<Uint8Array> with a TransformStream that
 * resets a timer on every chunk. On 60s stall mid-stream it synthesizes a
 * graceful finish (OpenAI: finish_reason:stop + [DONE] / Anthropic:
 * message_delta + message_stop), terminates the readable gracefully and
 * aborts the upstream controller.
 *
 * Client disconnect is handled via AbortSignal → propagates to upstream.
 */

export const STALL_TIMEOUT_MS = 60_000

export type StallFormat = 'openai' | 'anthropic'

export interface StallWatchdogOptions {
  /** stall timeout — default 60_000 ms */
  timeoutMs?: number
  /** SSE wire format for synthesized finish — default 'openai' */
  format?: StallFormat
  /** client disconnect signal (e.g. Hono request.signal). Abort → upstream abort + terminate */
  signal?: AbortSignal | undefined
  /** upstream AbortController to propagate abort on stall / client close */
  upstreamController?: AbortController | undefined
  /** called once when stall fires, before synthetic enqueue */
  onStall?: (() => void) | undefined
}

const encoder = new TextEncoder()

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** OpenAI SSE: one chunk with finish_reason:stop + terminal [DONE] */
export function createOpenAIStallChunk(): Uint8Array {
  const payload = JSON.stringify({
    id: 'chatcmpl-stall',
    object: 'chat.completion.chunk',
    created: nowSec(),
    model: 'stall-watchdog',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  return encoder.encode(`data: ${payload}\n\ndata: [DONE]\n\n`)
}

/** Anthropic SSE: message_delta (stop_reason:end_turn) + message_stop */
export function createAnthropicStallChunks(): Uint8Array[] {
  const delta = JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 0 },
  })
  const stop = JSON.stringify({ type: 'message_stop' })
  return [
    encoder.encode(`event: message_delta\ndata: ${delta}\n\n`),
    encoder.encode(`event: message_stop\ndata: ${stop}\n\n`),
  ]
}

function syntheticForFormat(format: StallFormat): Uint8Array[] {
  if (format === 'anthropic') return createAnthropicStallChunks()
  return [createOpenAIStallChunk()]
}

export class StallWatchdog {
  readonly timeoutMs: number
  readonly format: StallFormat
  readonly signal: AbortSignal | undefined
  readonly upstreamController: AbortController | undefined
  readonly onStall: (() => void) | undefined

  constructor(opts: StallWatchdogOptions = {}) {
    const t = opts.timeoutMs
    this.timeoutMs = t === undefined ? STALL_TIMEOUT_MS : t
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError(
        `timeoutMs must be positive finite, got ${this.timeoutMs}`,
      )
    }
    this.format = opts.format ?? 'openai'
    // @ts-ignore - exactOptionalPropertyTypes: allow undefined for optional signal
    this.signal = opts.signal
    // @ts-ignore - exactOptionalPropertyTypes: allow undefined
    this.upstreamController = opts.upstreamController
    // @ts-ignore - exactOptionalPropertyTypes: allow undefined
    this.onStall = opts.onStall
  }

  /**
   * Create a TransformStream that implements the watchdog.
   * - resets timer on every transform(chunk)
   * - on stall (timeoutMs no chunk) enqueues synthetic finish + [DONE]/message_stop and terminates gracefully
   * - propagates client signal abort → upstream abort + terminate
   * - clears timer on flush / cancel to avoid leak
   */
  createTransform(): TransformStream<Uint8Array, Uint8Array> {
    const timeoutMs = this.timeoutMs
    const format = this.format
    const clientSignal = this.signal
    const upstreamController = this.upstreamController
    const onStall = this.onStall

    let timer: ReturnType<typeof setTimeout> | null = null
    let stalled = false
    let finished = false
    let controllerRef: TransformStreamDefaultController<Uint8Array> | null =
      null

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const doStall = () => {
      if (stalled || finished) return
      stalled = true
      clearTimer()
      try {
        onStall?.()
      } catch {
        // onStall must not break stall synthesis
      }
      // abort upstream first (save GPU tokens)
      try {
        upstreamController?.abort(
          new DOMException('stall watchdog timeout', 'AbortError'),
        )
      } catch {
        // ignore abort throw
      }
      const chunks = syntheticForFormat(format)
      if (controllerRef) {
        for (const c of chunks) {
          try {
            controllerRef.enqueue(c)
          } catch {
            // controller already errored/closed
            break
          }
        }
        // graceful close — readable ends after synthetic chunks
        try {
          const ctrl = controllerRef as unknown as {
            terminate?: () => void
            close?: () => void
          }
          if (typeof ctrl.terminate === 'function') ctrl.terminate()
          // fallback: if terminate not available, enqueue will flush and stream ends via flush return; nothing to do
        } catch {
          // ignore
        }
      }
      // remove client abort listener — stall is terminal
      if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort)
    }

    const arm = () => {
      clearTimer()
      if (finished || stalled) return
      timer = setTimeout(doStall, timeoutMs)
      // Node/Bun: allow process to exit if only timer remains — but keep watchdog alive for streams
      // don't unref; watchdog must fire even if event loop otherwise idle
    }

    const onClientAbort = () => {
      if (finished || stalled) return
      finished = true
      clearTimer()
      try {
        upstreamController?.abort(
          (clientSignal?.reason as Error) ??
            new DOMException('client aborted', 'AbortError'),
        )
      } catch {}
      const ctrl = controllerRef as unknown as {
        error?: (e: unknown) => void
        terminate?: () => void
      } | null
      // terminate gracefully — downstream reader will see done:true rather than error,
      // but upstream abort ensures no further work
      try {
        ctrl?.terminate?.()
      } catch {
        try {
          ctrl?.error?.(
            clientSignal?.reason ??
              new DOMException('client aborted', 'AbortError'),
          )
        } catch {}
      }
    }

    return new TransformStream<Uint8Array, Uint8Array>({
      start(controller: TransformStreamDefaultController<Uint8Array>) {
        controllerRef = controller
        if (clientSignal?.aborted) {
          onClientAbort()
          return
        }
        if (clientSignal) {
          clientSignal.addEventListener('abort', onClientAbort, { once: true })
        }
        arm()
      },
      transform(
        chunk: Uint8Array,
        controller: TransformStreamDefaultController<Uint8Array>,
      ) {
        if (stalled || finished) return
        clearTimer()
        // pass through verbatim
        controller.enqueue(chunk)
        arm()
      },
      flush(_controller: TransformStreamDefaultController<Uint8Array>) {
        if (stalled) return
        finished = true
        clearTimer()
        if (clientSignal)
          clientSignal.removeEventListener('abort', onClientAbort)
      },
      // @ts-ignore - Transformer cancel not in lib.dom types
      cancel(_reason: unknown) {
        if (stalled) return
        finished = true
        clearTimer()
        if (clientSignal)
          clientSignal.removeEventListener('abort', onClientAbort)
        try {
          upstreamController?.abort(
            new DOMException('consumer cancel', 'AbortError'),
          )
        } catch {}
      },
    } as unknown as Transformer<Uint8Array, Uint8Array>)
  }

  /**
   * Wrap an existing ReadableStream with the watchdog TransformStream.
   * Convenience: stream.pipeThrough(watchdog.createTransform())
   */
  wrap(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return stream.pipeThrough(this.createTransform())
  }
}

/**
 * Functional wrapper — mirrors withEarlyKeepalive shape for ergonomic piping.
 * Creates a StallWatchdog and wraps the stream in one call.
 */
export function withStallWatchdog(
  stream: ReadableStream<Uint8Array>,
  opts?: StallWatchdogOptions,
): ReadableStream<Uint8Array> {
  return new StallWatchdog(opts).wrap(stream)
}

export default StallWatchdog
