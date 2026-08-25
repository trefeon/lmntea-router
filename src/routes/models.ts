import type { Hono } from 'hono'
import { MODEL_REGISTRY } from '../config/models.js'
import { recommendedTier, valueScore } from '../intelligence/scoring.js'
import type { SyncedModel } from '../intelligence/sync.js'
import { getSyncedSnapshot, lastSyncAt } from '../intelligence/sync.js'
import { getRequestId } from '../middleware/requestId.js'
import type { Env } from '../types.js'

function buildEnrichedEntry(
  id: string,
  now: number,
  snapshot: Map<string, SyncedModel> | null,
  lastAt: number | null,
) {
  const spec = MODEL_REGISTRY[id]
  const provider = spec?.provider ?? id.split('/')[0] ?? 'unknown'

  let synced: SyncedModel | undefined
  if (snapshot) {
    synced = snapshot.get(id)
    if (!synced) synced = snapshot.get(id.toLowerCase())
  }

  const contextLength = synced?.contextLength ?? spec?.contextWindow ?? 128_000
  const maxCompletionTokens =
    synced?.maxCompletionTokens ?? spec?.maxOutputTokens ?? 8192
  const inputModalities = synced?.inputModalities ?? ['text']
  const outputModalities = synced?.outputModalities ?? ['text']
  const supportedParameters =
    synced?.supportedParameters ?? (spec ? [...spec.supportedParams] : [])

  const pricing = synced?.pricing
    ? {
        prompt: synced.pricing.prompt,
        completion: synced.pricing.completion,
        ...(synced.pricing.request ? { request: synced.pricing.request } : {}),
        ...(synced.pricing.image ? { image: synced.pricing.image } : {}),
        ...(synced.pricing.input_cache_read
          ? { input_cache_read: synced.pricing.input_cache_read }
          : {}),
      }
    : undefined

  const pricePer1MInput = synced?.pricePer1MInput ?? 0
  const pricePer1MOutput = synced?.pricePer1MOutput ?? 0
  const totalPrice = pricePer1MInput + pricePer1MOutput

  const quality = synced?.codingIndex ?? synced?.intelligenceIndex ?? null

  const vs = synced
    ? valueScore(quality ?? 0, totalPrice)
    : spec
      ? spec.contextWindow / 10_000
      : 0

  const tier = synced
    ? recommendedTier(synced.codingIndex ?? null, totalPrice)
    : 'budget_free'

  const base: Record<string, unknown> = {
    id,
    object: 'model',
    created: now,
    owned_by: provider,
    context_length: contextLength,
    max_completion_tokens: maxCompletionTokens,
    input_modalities: inputModalities,
    output_modalities: outputModalities,
    supported_parameters: supportedParameters,
  }

  if (pricing) base.pricing = pricing
  if (synced) {
    base.quality = quality
    base.valueScore = vs
    base.value_score = vs
    base.tier = tier
    base.recommended_tier = tier
    base.intelligence_index = synced.intelligenceIndex
    base.coding_index = synced.codingIndex
    base.output_tokens_per_second = synced.outputTokensPerSecond
    base.time_to_first_token_sec = synced.timeToFirstTokenSec
  } else {
    base.quality = null
    base.valueScore = vs
    base.value_score = vs
    base.tier = tier
    base.recommended_tier = tier
  }

  if (lastAt !== null && lastAt !== undefined) {
    base.lastSyncedAt = lastAt
    base.last_synced_at = lastAt
  }

  return base
}

function extractModelIdFromPath(url: string): string {
  try {
    const u = new URL(url)
    const prefix = '/v1/models/'
    const path = u.pathname
    if (!path.startsWith(prefix)) return ''
    const encoded = path.slice(prefix.length)
    if (encoded.length === 0) return ''
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  } catch {
    return ''
  }
}

export function mountModels(app: Hono<Env>) {
  app.get('/v1/models', (c) => {
    const now = Math.floor(Date.now() / 1000)
    const snapshot = getSyncedSnapshot()
    const lastAt = lastSyncAt
    const url = new URL(c.req.url)
    const providerFilter = url.searchParams.get('provider')

    const ids = new Set<string>(Object.keys(MODEL_REGISTRY))
    if (snapshot) {
      for (const key of snapshot.keys()) {
        ids.add(key)
      }
    }

    let filtered = [...ids]
    if (providerFilter && providerFilter.length > 0) {
      const pf = providerFilter.toLowerCase()
      filtered = filtered.filter((id) => {
        const prov = id.split('/')[0]?.toLowerCase() ?? ''
        return prov === pf || id.toLowerCase().startsWith(`${pf}/`)
      })
    }

    filtered.sort()

    const data = filtered.map((id) =>
      buildEnrichedEntry(id, now, snapshot, lastAt),
    )

    return c.json({
      object: 'list',
      data,
    })
  })

  const singleHandler = (c: {
    req: { url: string; param: (k: string) => string | undefined }
    header: (k: string, v: string) => void
    json: (b: unknown, s?: number) => Response
  }) => {
    const paramId = c.req.param('id') ?? c.req.param('*') ?? ''
    let id = paramId
    const fullId = extractModelIdFromPath(c.req.url)
    if (fullId.length > 0 && fullId.length >= id.length) id = fullId

    if (!id) {
      const requestId = getRequestId(c as unknown as never)
      return c.json(
        {
          error: {
            type: 'not_found_error',
            message: 'Model not found',
            code: 'MODEL_NOT_FOUND',
          },
          ...(requestId ? { request_id: requestId } : {}),
        },
        404,
      )
    }

    const snapshot = getSyncedSnapshot()
    const lastAt = lastSyncAt
    const now = Math.floor(Date.now() / 1000)

    const inRegistry = id in MODEL_REGISTRY
    const inSnapshot = snapshot
      ? snapshot.has(id) || snapshot.has(id.toLowerCase())
      : false

    if (!inRegistry && !inSnapshot) {
      const requestId = getRequestId(c as unknown as never)
      return c.json(
        {
          error: {
            type: 'not_found_error',
            message: 'Model not found',
            code: 'MODEL_NOT_FOUND',
          },
          ...(requestId ? { request_id: requestId } : {}),
        },
        404,
      )
    }

    const entry = buildEnrichedEntry(id, now, snapshot, lastAt)
    return c.json(entry)
  }

  // encoded slash: /v1/models/opencode%2Fx-preview
  app.get('/v1/models/:id', singleHandler as unknown as never)
  // literal slash: /v1/models/opencode/x-preview-f-free
  app.get('/v1/models/*', singleHandler as unknown as never)
}
