/**
 * intelligence/sync.ts — advisory background sync (OpenRouter + Artificial Analysis)
 *
 * Fetches OpenRouter models (public, no auth) and Artificial Analysis v2
 * (optional, keyed) with 10 s AbortController timeout per feed, merges into
 * a SyncedModel map, and never throws to the request path. Failures fall back
 * to the static MODEL_REGISTRY (i.e. the snapshot stays at its last good value
 * or empty on cold start).
 *
 * Exports:
 *  - syncOnce() — single merge attempt, never throws
 *  - startIntelligenceSync({ intervalMs }) — background interval with unref timer
 *  - getSyncedSnapshot() / lastSyncAt — for scoring and GET /v1/models
 *  - typed interfaces for OpenRouter + AA payloads
 */

import { isPrivateHostname } from '../router/transport.js'

export interface OpenRouterModel {
  id: string
  canonical_slug: string
  name: string
  created: number
  description: string
  context_length: number
  architecture: {
    modality: string
    input_modalities: ('text' | 'image' | 'audio' | 'file')[]
    output_modalities: ('text' | 'image' | 'audio')[]
    tokenizer: string
    instruct_type: string | null
  }
  top_provider: {
    context_length: number
    max_completion_tokens: number
    is_moderated: boolean
  }
  supported_parameters: string[]
  default_parameters?: Record<string, unknown> | null
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
    supported_efforts?: ('low' | 'medium' | 'high' | 'max')[]
    default_effort?: 'low' | 'medium' | 'high' | 'max'
  }
  pricing: {
    prompt: string
    completion: string
    request?: string
    image?: string
    input_cache_read?: string
    input_cache_write?: string
    internal_reasoning?: string
  }
}

export interface OpenRouterResponse {
  data: OpenRouterModel[]
  total_count?: number
  links?: { next: string | null }
}

export interface ArtificialAnalysisModel {
  slug?: string
  id?: string
  name?: string
  canonical_slug?: string
  // Allow both flat and nested shapes seen in AA v2 variants
  evaluations?: {
    artificial_analysis_intelligence_index?: number | null
    artificial_analysis_coding_index?: number | null
    artificial_analysis_agentic_index?: number | null
    intelligence_index?: number | null
    coding_index?: number | null
  } | null
  intelligence_index?: number | null
  coding_index?: number | null
  artificial_analysis_intelligence_index?: number | null
  artificial_analysis_coding_index?: number | null
  performance?: {
    median_output_tokens_per_second?: number | null
    median_time_to_first_token_seconds?: number | null
    output_tokens_per_second?: number | null
    time_to_first_token_seconds?: number | null
  } | null
  pricing?: {
    price_1m_input_tokens?: number | null
    price_1m_output_tokens?: number | null
  } | null
  // permissive passthrough
  [key: string]: unknown
}

export interface ArtificialAnalysisResponse {
  data: ArtificialAnalysisModel[]
}

export interface SyncedModel {
  id: string
  canonicalSlug: string
  name: string
  description: string
  contextLength: number
  maxCompletionTokens: number
  inputModalities: ('text' | 'image' | 'audio' | 'file')[]
  outputModalities: ('text' | 'image' | 'audio')[]
  supportedParameters: string[]
  supportedReasoningEfforts?: ('low' | 'medium' | 'high' | 'max')[]
  pricing: {
    prompt: string
    completion: string
    request?: string
    image?: string
    input_cache_read?: string
  }
  pricePer1MInput: number
  pricePer1MOutput: number
  pricePer1MCacheRead?: number
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
  outputTokensPerSecond: number | null
  timeToFirstTokenSec: number | null
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let syncedSnapshot: Map<string, SyncedModel> | null = null

export let lastSyncAt: number | null = null

let timer: ReturnType<typeof setInterval> | null = null

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

const FETCH_TIMEOUT_MS = 10_000

function getOpenRouterUrl(): string {
  const envUrl =
    process.env.OPENROUTER_API_URL ??
    process.env.OPENROUTER_API_BASE_URL ??
    process.env.OPENROUTER_URL ??
    ''
  if (envUrl.trim().length > 0) return envUrl.trim()
  return 'https://openrouter.ai/api/v1/models'
}

function getArtificialAnalysisUrl(): string {
  const envUrl =
    process.env.ARTIFICIAL_ANALYSIS_API_URL ??
    process.env.AA_API_URL ??
    process.env.ARTIFICIAL_ANALYSIS_URL ??
    ''
  if (envUrl.trim().length > 0) return envUrl.trim()
  return 'https://artificialanalysis.ai/api/v2/data/llms/models'
}

function getOpenRouterApiKey(): string | undefined {
  const k = process.env.OPENROUTER_API_KEY?.trim()
  return k && k.length > 0 ? k : undefined
}

function getAAApiKey(): string | undefined {
  const k =
    process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim() ??
    process.env.AA_API_KEY?.trim() ??
    ''
  return k && k.length > 0 ? k.trim() : undefined
}

// ---------------------------------------------------------------------------
// SSRF guard — single source of truth in src/router/transport.ts
// ---------------------------------------------------------------------------

function assertSafeUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`Invalid sync URL: ${raw}`)
  }
  if (!['http:', 'https:'].includes(u.protocol))
    throw new Error(`Forbidden protocol: ${u.protocol}`)
  if (isPrivateHostname(u.hostname))
    throw new Error(`SSRF blocked: ${u.hostname}`)
  if (u.username || u.password) throw new Error('Credentials in URL forbidden')
  return u
}

// ---------------------------------------------------------------------------
// Fetch with timeout (10 s) + AbortController, never leaks timer
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  assertSafeUrl(url)
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), timeoutMs)
  // Merge caller signal if present (AbortSignal.any where available)
  let signal: AbortSignal | undefined = controller.signal
  const callerSignal = init.signal as AbortSignal | undefined
  if (callerSignal) {
    const AnySignal = AbortSignal as unknown as {
      any?: (s: AbortSignal[]) => AbortSignal
    }
    if (typeof AnySignal.any === 'function') {
      signal = AnySignal.any([controller.signal, callerSignal])
    } else {
      // Fallback: if caller already aborted, abort immediately
      if (callerSignal.aborted) {
        clearTimeout(timerId)
        controller.abort(
          (callerSignal as unknown as { reason?: unknown }).reason,
        )
      } else {
        const onCallerAbort = () => {
          const holder = callerSignal as unknown as { reason?: unknown }
          controller.abort(holder.reason)
        }
        callerSignal.addEventListener('abort', onCallerAbort, { once: true })
        // ensure cleanup on our timeout path — listener is once, no extra clear needed
      }
    }
  }
  try {
    const res = await fetch(url, { ...init, signal })
    return res
  } finally {
    clearTimeout(timerId)
  }
}

// ---------------------------------------------------------------------------
// Parsers / merge helpers
// ---------------------------------------------------------------------------

function parsePricePerMillion(value: string | undefined): number {
  if (!value) return 0
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return n * 1_000_000
}

function toSyncedModel(
  or: OpenRouterModel,
  aa: ArtificialAnalysisModel | undefined,
): SyncedModel {
  const pricePer1MInput = parsePricePerMillion(or.pricing?.prompt)
  const pricePer1MOutput = parsePricePerMillion(or.pricing?.completion)
  const pricePer1MCacheRead = or.pricing?.input_cache_read
    ? parsePricePerMillion(or.pricing.input_cache_read)
    : undefined

  // AA fields — tolerate multiple shapes
  const evals = (aa?.evaluations ?? null) as {
    artificial_analysis_intelligence_index?: number | null
    artificial_analysis_coding_index?: number | null
    artificial_analysis_agentic_index?: number | null
    intelligence_index?: number | null
    coding_index?: number | null
  } | null

  const intelligenceIndex =
    evals?.artificial_analysis_intelligence_index ??
    evals?.intelligence_index ??
    (aa?.artificial_analysis_intelligence_index as number | undefined) ??
    (aa?.intelligence_index as number | undefined) ??
    null

  const codingIndex =
    evals?.artificial_analysis_coding_index ??
    evals?.coding_index ??
    (aa?.artificial_analysis_coding_index as number | undefined) ??
    (aa?.coding_index as number | undefined) ??
    null

  const agenticIndex =
    (evals?.artificial_analysis_agentic_index as number | undefined) ?? null

  const perf = (aa?.performance ?? null) as {
    median_output_tokens_per_second?: number | null
    median_time_to_first_token_seconds?: number | null
    output_tokens_per_second?: number | null
    time_to_first_token_seconds?: number | null
  } | null

  const outputTokensPerSecond =
    perf?.median_output_tokens_per_second ??
    perf?.output_tokens_per_second ??
    null

  const timeToFirstTokenSec =
    perf?.median_time_to_first_token_seconds ??
    perf?.time_to_first_token_seconds ??
    null

  const contextLength =
    or.context_length ?? or.top_provider?.context_length ?? 128_000
  const maxCompletionTokens = or.top_provider?.max_completion_tokens ?? 8192

  const base: SyncedModel = {
    id: or.id,
    canonicalSlug: or.canonical_slug ?? or.id,
    name: or.name ?? or.id,
    description: or.description ?? '',
    contextLength,
    maxCompletionTokens,
    inputModalities: (or.architecture
      ?.input_modalities as SyncedModel['inputModalities']) ?? ['text'],
    outputModalities: (or.architecture
      ?.output_modalities as SyncedModel['outputModalities']) ?? ['text'],
    supportedParameters: or.supported_parameters ?? [],
    pricing: {
      prompt: or.pricing?.prompt ?? '0',
      completion: or.pricing?.completion ?? '0',
      ...(or.pricing?.request ? { request: or.pricing.request } : {}),
      ...(or.pricing?.image ? { image: or.pricing.image } : {}),
      ...(or.pricing?.input_cache_read
        ? { input_cache_read: or.pricing.input_cache_read }
        : {}),
    },
    pricePer1MInput,
    pricePer1MOutput,
    intelligenceIndex:
      typeof intelligenceIndex === 'number' &&
      Number.isFinite(intelligenceIndex)
        ? intelligenceIndex
        : null,
    codingIndex:
      typeof codingIndex === 'number' && Number.isFinite(codingIndex)
        ? codingIndex
        : null,
    agenticIndex:
      typeof agenticIndex === 'number' && Number.isFinite(agenticIndex)
        ? agenticIndex
        : null,
    outputTokensPerSecond:
      typeof outputTokensPerSecond === 'number' &&
      Number.isFinite(outputTokensPerSecond)
        ? outputTokensPerSecond
        : null,
    timeToFirstTokenSec:
      typeof timeToFirstTokenSec === 'number' &&
      Number.isFinite(timeToFirstTokenSec)
        ? timeToFirstTokenSec
        : null,
  }
  if (pricePer1MCacheRead !== undefined) {
    base.pricePer1MCacheRead = pricePer1MCacheRead
  }
  const reasoningEfforts = or.reasoning?.supported_efforts as
    | SyncedModel['supportedReasoningEfforts']
    | undefined
  if (reasoningEfforts) {
    base.supportedReasoningEfforts = reasoningEfforts
  }
  return base
}

function buildAaMap(
  aaModels: ArtificialAnalysisModel[],
): Map<string, ArtificialAnalysisModel> {
  const map = new Map<string, ArtificialAnalysisModel>()
  for (const m of aaModels) {
    const candidates: (string | undefined)[] = [
      m.slug as string | undefined,
      m.canonical_slug as string | undefined,
      m.id as string | undefined,
      m.name as string | undefined,
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim().length > 0) {
        const key = c.toLowerCase().trim()
        if (!map.has(key)) map.set(key, m)
      }
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSyncedSnapshot(): Map<string, SyncedModel> | null {
  return syncedSnapshot
}

/**
 * Single advisory sync attempt.
 * - Fetches OpenRouter (public) + AA (optional, keyed) each with 10 s timeout
 * - Merges by canonical_slug / id (case-insensitive)
 * - Never throws — on any failure returns the last good snapshot or an empty map
 */
export async function syncOnce(): Promise<Map<string, SyncedModel>> {
  let orModels: OpenRouterModel[] = []
  let aaModels: ArtificialAnalysisModel[] = []

  // 1) OpenRouter — public, optional OPENROUTER_API_KEY bearer if set
  try {
    const url = getOpenRouterUrl()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'lmntea-router/1.0',
    }
    const orKey = getOpenRouterApiKey()
    if (orKey) headers.Authorization = `Bearer ${orKey}`
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers },
      FETCH_TIMEOUT_MS,
    )
    if (!res.ok) {
      // Advisory: log and keep orModels empty — caller falls back
      // Use console.warn so it is visible but not fatal
      console.warn(
        `[intelligence/sync] OpenRouter fetch failed: ${res.status} ${res.statusText}`,
      )
    } else {
      const json = (await res.json()) as OpenRouterResponse & { data?: unknown }
      const data = (json as unknown as { data?: OpenRouterModel[] }).data
      if (Array.isArray(data)) orModels = data
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // AbortError from timeout is expected — treat as advisory
    console.warn(
      `[intelligence/sync] OpenRouter fetch error (advisory): ${msg}`,
    )
  }

  // 2) Artificial Analysis — optional; skip silently if no key, timeout/401 falls back to OR alone
  const aaKey = getAAApiKey()
  if (aaKey) {
    try {
      const url = getArtificialAnalysisUrl()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'lmntea-router/1.0',
        'x-api-key': aaKey,
        Authorization: `Bearer ${aaKey}`,
      }
      const res = await fetchWithTimeout(
        url,
        { method: 'GET', headers },
        FETCH_TIMEOUT_MS,
      )
      if (!res.ok) {
        console.warn(
          `[intelligence/sync] AA fetch failed: ${res.status} ${res.statusText} — falling back to OpenRouter alone`,
        )
      } else {
        const json = (await res.json()) as ArtificialAnalysisResponse & {
          data?: unknown
          models?: unknown
        }
        // tolerate { data: [...] } or { models: [...] } or plain array
        const raw = json as unknown as Record<string, unknown>
        const data: unknown = raw.data ?? raw.models ?? raw
        if (Array.isArray(data)) {
          aaModels = data as ArtificialAnalysisModel[]
        } else if (
          raw &&
          typeof raw === 'object' &&
          Array.isArray((raw as { data?: unknown }).data)
        ) {
          aaModels = (raw as { data: ArtificialAnalysisModel[] }).data
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[intelligence/sync] AA fetch error (advisory, OR alone): ${msg}`,
      )
    }
  }

  // 3) Merge — if OR produced nothing, keep last good snapshot (or empty) and do not overwrite
  if (orModels.length === 0) {
    // Still update lastSyncAt so callers know a sync attempt occurred
    lastSyncAt = Date.now()
    // Return existing snapshot or empty map — never throw
    if (syncedSnapshot) return syncedSnapshot
    syncedSnapshot = new Map<string, SyncedModel>()
    return syncedSnapshot
  }

  const aaMap = buildAaMap(aaModels)
  const next = new Map<string, SyncedModel>()

  for (const or of orModels) {
    if (!or || typeof or.id !== 'string' || or.id.trim().length === 0) continue
    const slugKey = (or.canonical_slug ?? or.id).toLowerCase().trim()
    const idKey = or.id.toLowerCase().trim()
    const aa = aaMap.get(slugKey) ?? aaMap.get(idKey)
    const merged = toSyncedModel(or, aa)
    next.set(or.id, merged)
    // Also index by canonical_slug for lookup convenience (if distinct)
    if (or.canonical_slug && or.canonical_slug !== or.id) {
      if (!next.has(or.canonical_slug)) next.set(or.canonical_slug, merged)
    }
  }

  syncedSnapshot = next
  lastSyncAt = Date.now()
  return next
}

export interface StartIntelligenceSyncOptions {
  intervalMs?: number
}

/**
 * Start advisory background sync.
 * - Calls syncOnce() once in the background (never blocks, never throws)
 * - Then schedules periodic syncEvery intervalMs (default 6h) with an unref timer
 * - Returns a handle with stop() to clear the interval (useful in tests)
 */
export function startIntelligenceSync(
  opts: StartIntelligenceSyncOptions = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  // defensively clear previous timer if start called twice
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  // Fire-and-forget initial sync — advisory, never throws
  void syncOnce().catch(() => {
    // syncOnce itself never rejects, but guard anyway
  })

  timer = setInterval(() => {
    void syncOnce().catch(() => {})
  }, intervalMs)

  // Do not keep the process alive — advisory background work
  const maybeUnref = timer as unknown as { unref?: () => void }
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref()

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/** Test-only helper: reset module state without touching the filesystem */
export function __resetIntelligenceStateForTests(): void {
  syncedSnapshot = null
  lastSyncAt = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
