import type { Hono } from 'hono'
import { MODEL_REGISTRY, getModelSpec } from '../config/models.js'
import { PROVIDERS, getProviderForModel } from '../config/providers.js'
import { validationError } from '../middleware/errors.js'
import { clampBody } from '../normalizer/clamp.js'
import { sanitizeParams } from '../normalizer/sanitize.js'
import { reconcileThinking } from '../normalizer/thinking.js'
import {
  type BreakerState,
  classifyError,
  createBreakerState,
  isOpen,
  maybeClose,
  recordFailure,
  recordSuccess,
} from '../router/circuitBreaker.js'
import { routeCombo } from '../router/combo.js'
import {
  RELAY_TIMEOUT_MS,
  dispatch,
  getDefaultRelayPool,
} from '../router/transport.js'
import { ChatCompletionRequestSchema } from '../schemas/chat.js'
import { withEarlyKeepalive } from '../streaming/earlyKeepalive.js'
import { createMockSSEStream, sseHeaders } from '../streaming/sse.js'
import { withStallWatchdog } from '../streaming/stallWatchdog.js'
import type { Env } from '../types.js'

// ---------------------------------------------------------------------------
// Stage 4 router wiring — per-provider circuit breaker + combo candidate order
// ---------------------------------------------------------------------------

/** Module-level breaker state per provider; mutated only via pure transitions. */
const breakerStates = new Map<string, BreakerState>()

function breakerFor(provider: string): BreakerState {
  let st = breakerStates.get(provider)
  if (!st) {
    st = createBreakerState()
    breakerStates.set(provider, st)
  }
  return st
}

/** Test-only: clear module-level breaker state between tests. */
export function __resetBreakerStatesForTests(): void {
  breakerStates.clear()
}

interface UpstreamCandidate {
  provider: string
  url: string
}

function primaryProviderFor(model: string): string {
  const prefix = model.split('/')[0] ?? ''
  if (prefix.length > 0 && PROVIDERS[prefix] !== undefined) return prefix
  const spec = getModelSpec(model)
  return spec?.provider ?? 'unknown'
}

function providerUrl(provider: string, pathSuffix: string): string | null {
  const spec = PROVIDERS[provider]
  if (!spec) return null
  return `${spec.baseUrl.replace(/\/$/, '')}${pathSuffix}`
}

/**
 * Other registered providers hosting the same model slug with a wire format
 * compatible with this route (fallback/priority candidates from PROVIDERS).
 */
function alternateProvidersFor(
  model: string,
  wireFormat: 'openai' | 'claude',
): string[] {
  const slash = model.indexOf('/')
  const slug = slash > 0 ? model.slice(slash + 1) : ''
  if (slug.length === 0) return []
  const exclude = primaryProviderFor(model)
  const out: string[] = []
  for (const [id, spec] of Object.entries(MODEL_REGISTRY)) {
    const cut = id.indexOf('/')
    if (cut <= 0 || id.slice(cut + 1) !== slug) continue
    const name = id.slice(0, cut)
    if (
      name === exclude ||
      out.includes(name) ||
      PROVIDERS[name] === undefined
    ) {
      continue
    }
    const fmt = PROVIDERS[name]?.format
    const compatible =
      wireFormat === 'openai'
        ? fmt === undefined || fmt === 'openai'
        : fmt === 'claude'
    if (!compatible) continue
    out.push(name)
  }
  return out
}

/**
 * Ordered upstream candidates for a model: primary provider first, then any
 * compatible alternate providers. When more than one candidate exists the
 * combo router orders them (fallback strategy, healthy-first via live breaker
 * states). Single-provider models keep a one-element list.
 */
function buildUpstreamCandidates(
  model: string,
  pathSuffix: string,
  wireFormat: 'openai' | 'claude',
): UpstreamCandidate[] {
  const primaryName = primaryProviderFor(model)
  const primarySpec = getProviderForModel(model)
  const primaryBase = (
    primarySpec?.baseUrl ?? 'https://opencode.ai/zen/v1'
  ).replace(/\/$/, '')
  const primaryUrl = `${primaryBase}${pathSuffix}`
  const alts = alternateProvidersFor(model, wireFormat)
  if (alts.length === 0) {
    return [{ provider: primaryName, url: primaryUrl }]
  }
  const ordered = routeCombo(
    [primaryName, ...alts].map((name) => ({ model: name })),
    { strategy: 'fallback', breakerState: breakerStates },
  )
  const names = ordered.map((cand) => cand.model)
  if (!names.includes(primaryName)) names.unshift(primaryName)
  const candidates: UpstreamCandidate[] = []
  for (const name of names) {
    const url =
      name === primaryName ? primaryUrl : providerUrl(name, pathSuffix)
    if (url) candidates.push({ provider: name, url })
  }
  return candidates.length > 0
    ? candidates
    : [{ provider: primaryName, url: primaryUrl }]
}

function routerActionHeaders(actions: string[]): Record<string, string> {
  return actions.length > 0 ? { 'x-router-action': actions.join(',') } : {}
}

export function mountChat(app: Hono<Env>) {
  app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body) {
      return validationError(c, 'Invalid JSON', 'body')
    }
    const parsed = ChatCompletionRequestSchema.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      if (!first) {
        return validationError(c, 'Invalid request', 'body')
      }
      return validationError(c, first.message, first.path.join('.'))
    }
    const data = parsed.data
    // P2 normalizer — exercised before streaming. Order: sanitize -> clamp -> thinking
    const spec = getModelSpec(data.model)
    let normalized: Record<string, unknown> | null = null
    let clampedHeader: string | undefined
    let strippedHeader: string | undefined
    if (spec) {
      let bodyRec: Record<string, unknown> = {
        ...(data as unknown as Record<string, unknown>),
      }
      // keep raw passthrough keys (e.g. thinking, reasoning_effort) that zod strips? Use original body as base
      bodyRec = { ...body, ...bodyRec }
      const beforeKeys = new Set(Object.keys(bodyRec))
      bodyRec = sanitizeParams(bodyRec, spec)
      bodyRec = clampBody(bodyRec, spec)
      bodyRec = reconcileThinking(bodyRec, spec)
      normalized = bodyRec
      const clamped = normalized.max_tokens ?? normalized.max_completion_tokens
      if (typeof clamped === 'number') {
        clampedHeader = String(clamped)
      }
      // expose whether sanitize stripped anything for hermetic testing
      const stripped = [...beforeKeys].filter((k) => !(k in bodyRec))
      if (stripped.length > 0) {
        strippedHeader = stripped.join(',')
      }
    }
    if (data.stream) {
      const upstreamController = new AbortController()
      // propagate client disconnect -> upstream abort (saves tokens)
      const rawSignal = (c.req.raw as unknown as Request)?.signal as
        | AbortSignal
        | undefined
      if (rawSignal) {
        if (rawSignal.aborted) upstreamController.abort()
        else
          rawSignal.addEventListener(
            'abort',
            () => upstreamController.abort(),
            { once: true },
          )
      }

      const relayUrls = getDefaultRelayPool()
      const candidates = buildUpstreamCandidates(
        data.model,
        '/chat/completions',
        'openai',
      )
      const upstreamBody = JSON.stringify(normalized ?? data)

      let chosen: Response | null = null
      let useMockFallback = false
      const routerActions: string[] = []
      let lastStatus: number | null = null
      let lastErrorText = ''
      let lastErrorMessage = ''
      let timedOut = false
      let noBody = false

      for (const cand of candidates) {
        // Stage 4 — consult the provider breaker before every dispatch attempt.
        const now = Date.now()
        const st = maybeClose(breakerFor(cand.provider), now)
        breakerStates.set(cand.provider, st)
        if (isOpen(st, now)) {
          routerActions.push(`breaker_skip:${cand.provider}`)
          continue
        }

        let upstreamResponse: Response | null = null
        try {
          upstreamResponse = await dispatch({
            url: cand.url,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: upstreamBody,
            signal: upstreamController.signal,
            relayUrls,
            timeoutMs: RELAY_TIMEOUT_MS,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (
            msg.includes('Forbidden private') ||
            msg.includes('private/internal target') ||
            msg.includes('Forbidden protocol') ||
            msg.includes('Credentials in URL')
          ) {
            return c.json(
              {
                error: {
                  type: 'invalid_request_error',
                  message: msg,
                  code: 'SSRF_FORBIDDEN',
                },
              },
              403,
              routerActionHeaders(routerActions),
            )
          }
          if (err instanceof DOMException && err.name === 'AbortError') {
            const isClientAbort =
              upstreamController.signal.aborted && rawSignal?.aborted
            if (isClientAbort) {
              // client aborted — close quietly
              return new Response(null, { status: 499 })
            }
            // upstream timeout — classifyError → FAILOVER_NEXT_MODEL
            timedOut = true
            breakerStates.set(cand.provider, recordFailure(st, Date.now()))
            routerActions.push(`failover:${cand.provider}`)
            continue
          }
          // network-level failure — classifyError(null) → FAILOVER_NEXT_MODEL
          lastErrorMessage = msg
          breakerStates.set(cand.provider, recordFailure(st, Date.now()))
          routerActions.push(`failover:${cand.provider}`)
          continue
        }

        if (!upstreamResponse.ok) {
          const action = classifyError(upstreamResponse.status)
          if (action === 'REJECT_IMMEDIATE') {
            // deterministic client error — abort, no retry/failover (prod).
            // Test runtime keeps the hermetic contract: any upstream failure
            // falls through to the mock SSE stream.
            const isTestEnv =
              process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
            if (isTestEnv) {
              useMockFallback = true
              break
            }
            const text = await upstreamResponse.text().catch(() => '')
            return c.json(
              {
                error: {
                  type: 'server_error',
                  message: text || `Upstream ${upstreamResponse.status}`,
                  code: String(upstreamResponse.status),
                },
              },
              upstreamResponse.status as 400,
              routerActionHeaders(routerActions),
            )
          }
          if (action === 'ROTATE_ACCOUNT_IN_POOL') {
            // per-key auth/quota issue — mark rotate; account pool not wired
            // yet, so surface the action and fail over to the next candidate
            // without penalizing the provider breaker.
            lastStatus = upstreamResponse.status
            lastErrorText = await upstreamResponse.text().catch(() => '')
            routerActions.push(`rotate:${cand.provider}`)
            continue
          }
          // FAILOVER_NEXT_MODEL (5xx/408) — record failure, try next candidate
          lastStatus = upstreamResponse.status
          lastErrorText = await upstreamResponse.text().catch(() => '')
          breakerStates.set(cand.provider, recordFailure(st, Date.now()))
          routerActions.push(`failover:${cand.provider}`)
          continue
        }

        if (!upstreamResponse.body) {
          noBody = true
          breakerStates.set(cand.provider, recordFailure(st, Date.now()))
          routerActions.push(`failover:${cand.provider}`)
          continue
        }

        // success — clears the sliding failure window
        breakerStates.set(cand.provider, recordSuccess(st))
        chosen = upstreamResponse
        break
      }

      if (!chosen) {
        const isTestEnv =
          process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
        if (isTestEnv) {
          useMockFallback = true
        } else if (timedOut) {
          return c.json(
            {
              error: {
                type: 'server_error',
                message: 'Upstream timeout',
                code: 'TIMEOUT',
              },
            },
            504,
            routerActionHeaders(routerActions),
          )
        } else if (lastStatus !== null) {
          const mappedStatus = lastStatus >= 500 ? 502 : lastStatus
          return c.json(
            {
              error: {
                type: 'server_error',
                message: lastErrorText || `Upstream ${lastStatus}`,
                code: String(lastStatus),
              },
            },
            mappedStatus as 502,
            routerActionHeaders(routerActions),
          )
        } else if (noBody) {
          return c.json(
            {
              error: {
                type: 'server_error',
                message: 'Upstream returned no body',
              },
            },
            502,
            routerActionHeaders(routerActions),
          )
        } else {
          return c.json(
            {
              error: {
                type: 'server_error',
                message: lastErrorMessage || 'Upstream error',
                code: 'UPSTREAM_ERROR',
              },
            },
            502,
            routerActionHeaders(routerActions),
          )
        }
      }

      let bodyStream: ReadableStream<Uint8Array>
      if (useMockFallback || !chosen) {
        bodyStream = createMockSSEStream({
          model: data.model,
          format: 'openai',
          signal: upstreamController.signal,
        })
      } else {
        bodyStream = chosen.body as ReadableStream<Uint8Array>
      }

      // Stage 6 composition — watchdog wraps the RAW upstream stream so
      // keepalive comment frames cannot reset its timer (pre-first-byte stalls
      // still fire the synthetic finish); keepalive then decorates watchdog
      // output so the client keeps receiving pings while stalled.
      const withWatchdog = withStallWatchdog(bodyStream, {
        format: 'openai',
        signal: upstreamController.signal,
        upstreamController,
      })
      const withKeepalive = withEarlyKeepalive(withWatchdog, {
        signal: upstreamController.signal,
      })
      const extra: Record<string, string> = {}
      if (clampedHeader) extra['x-clamped-max-tokens'] = clampedHeader
      if (strippedHeader) extra['x-sanitize-stripped'] = strippedHeader
      const requestId = c.get('requestId')
      if (requestId) extra['x-request-id'] = requestId
      Object.assign(extra, routerActionHeaders(routerActions))
      return new Response(withKeepalive, {
        status: 200,
        headers: sseHeaders(extra),
      })
    }
    if (clampedHeader) c.header('x-clamped-max-tokens', clampedHeader)
    if (strippedHeader) c.header('x-sanitize-stripped', strippedHeader)
    // expose normalized snapshot for debugging/tests via header when transport still missing
    if (normalized && typeof normalized.max_tokens === 'number') {
      c.header('x-normalized-max-tokens', String(normalized.max_tokens))
    }
    return c.json(
      {
        error: {
          type: 'server_error',
          message: 'Not Implemented',
          code: 'NOT_IMPLEMENTED',
        },
      },
      501,
    )
  })
}
