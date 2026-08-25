/**
 * SSE writer — pure formatting + Web Streams helpers.
 * No I/O, no timers, no global state. Tested hermetically via app.request().
 */

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Pure formatters (string level)
// ---------------------------------------------------------------------------

/** `: comment\\n\\n` — SSE comment frame (ignored by EventSource parsers, keeps proxies alive) */
export function formatComment(comment = 'keepalive'): string {
  // SSE spec: comment lines start with `:` and are terminated by double newline
  // Strip any newlines in comment to keep framing valid
  const safe = comment.replaceAll('\r', '').replaceAll('\n', ' ')
  return `: ${safe}\n\n`
}

/** `data: <json>\\n\\n` — JSON payload */
export function formatData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** `data: [DONE]\\n\\n` — terminal sentinel */
export function formatDone(): string {
  return 'data: [DONE]\n\n'
}

/** `event: <name>\\ndata: <json>\\n\\n` — Anthropic-style typed event */
export function formatEvent(event: string, data: unknown): string {
  const safeEvent = event.replaceAll('\r', '').replaceAll('\n', ' ')
  return `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Raw `data: <string>\\n\\n` for pre-serialized payloads */
export function formatRawData(raw: string): string {
  return `data: ${raw}\n\n`
}

// ---------------------------------------------------------------------------
// Uint8Array helpers (stream level)
// ---------------------------------------------------------------------------

export function encode(str: string): Uint8Array {
  return encoder.encode(str)
}

export function encodeComment(comment?: string): Uint8Array {
  return encode(formatComment(comment))
}

export function encodeData(data: unknown): Uint8Array {
  return encode(formatData(data))
}

export function encodeDone(): Uint8Array {
  return encode(formatDone())
}

export function encodeEvent(event: string, data: unknown): Uint8Array {
  return encode(formatEvent(event, data))
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export function sseHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Graceful finish synthesis (shared with stallWatchdog)
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions synthesized stall chunk: finish_reason stop + [DONE] */
export function createOpenAIStallChunk(): Uint8Array {
  const chunk = {
    id: 'chatcmpl-stall',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'stall-watchdog',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
  }
  return encode(formatData(chunk) + formatDone())
}

/** Anthropic Messages synthesized stall chunks: message_delta + message_stop */
export function createAnthropicStallChunks(): Uint8Array[] {
  const delta = formatEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  })
  const stop = formatEvent('message_stop', { type: 'message_stop' })
  return [encode(delta), encode(stop)]
}

// ---------------------------------------------------------------------------
// Mock upstream stream (hermetic testing / P4 without real upstream)
// ---------------------------------------------------------------------------

export interface MockStreamOptions {
  model?: string
  format?: 'openai' | 'anthropic'
  chunks?: unknown[] | string[] // custom payloads to emit as data:
  delayMs?: number // delay before first chunk (0 = immediate, >2000 triggers earlyKeepalive)
  signal?: AbortSignal
}

/**
 * Create a mock upstream SSE byte stream. Emits 1-2 JSON data frames + [DONE].
 * For anthropic format, emits typed events. Respects AbortSignal.
 */
export function createMockSSEStream(
  opts: MockStreamOptions = {},
): ReadableStream<Uint8Array> {
  const { model = 'mock-model', format = 'openai', delayMs = 0, signal } = opts

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (signal?.aborted) {
        controller.close()
        return
      }
      const onAbort = () => {
        try {
          controller.close()
        } catch {}
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        if (delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delayMs)
            const abortHandler = () => {
              clearTimeout(t)
              reject(new DOMException('Aborted', 'AbortError'))
            }
            signal?.addEventListener('abort', abortHandler, { once: true })
          })
        }
        if (signal?.aborted) return

        if (opts.chunks && opts.chunks.length > 0) {
          for (const c of opts.chunks) {
            if (signal?.aborted) break
            const payload =
              typeof c === 'string' ? formatRawData(c) : formatData(c)
            controller.enqueue(encode(payload))
          }
          if (!signal?.aborted) controller.enqueue(encodeDone())
        } else if (format === 'anthropic') {
          controller.enqueue(
            encode(
              formatEvent('message_start', {
                type: 'message_start',
                message: {
                  id: 'msg_mock',
                  type: 'message',
                  role: 'assistant',
                  model,
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 0, output_tokens: 1 },
                },
              }),
            ),
          )
          controller.enqueue(
            encode(
              formatEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello from mock upstream' },
              }),
            ),
          )
          controller.enqueue(
            encode(
              formatEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 1 },
              }),
            ),
          )
          controller.enqueue(
            encode(formatEvent('message_stop', { type: 'message_stop' })),
          )
        } else {
          const chunk = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: 'Hello from mock upstream' },
                finish_reason: null,
              },
            ],
          }
          controller.enqueue(encodeData(chunk))
          const finalChunk = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
          }
          controller.enqueue(encodeData(finalChunk))
          controller.enqueue(encodeDone())
        }
      } catch (e) {
        if ((e as DOMException)?.name !== 'AbortError') {
          // mid-stream error: serialize as SSE error event before closing (never throw)
          try {
            controller.enqueue(
              encodeData({
                error: { type: 'server_error', message: (e as Error).message },
              }),
            )
            controller.enqueue(encodeDone())
          } catch {}
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        try {
          controller.close()
        } catch {}
      }
    },
  })
}
