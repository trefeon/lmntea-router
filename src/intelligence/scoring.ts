/**
 * intelligence/scoring.ts — pure value scoring + tier ranking
 *
 * Pure functions only: no I/O, no globals, no mutation.
 * Used by router/combo value-driven strategy and GET /v1/models enrichment.
 *
 * Formulas (per roadmap P6-T02 + research/model_intelligence_...):
 *  valueScore = totalPrice > 0 ? codingIndex / totalPrice : 1000
 *  isWorthIt  = codingIndex >= 45 || totalPrice === 0
 *  recommendedTier = totalPrice === 0 ? 'budget_free'
 *                  : codingIndex > 75 ? 'frontier_coding'
 *                  : 'fast_agent'
 */

import { MODEL_REGISTRY } from '../config/models.js'
import type { SyncedModel } from './sync.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier =
  | 'frontier_coding'
  | 'fast_agent'
  | 'budget_free'
  | 'vision_multimodal'

export type RankCandidate =
  | string
  | {
      id?: string
      model?: string
      valueScore?: number
      tier?: string
      [key: string]: unknown
    }

export type SnapshotEntry = Partial<SyncedModel> & {
  valueScore?: number
  quality?: number
  price?: number
  codingIndex?: number | null
  intelligenceIndex?: number | null
  pricePer1MInput?: number
  pricePer1MOutput?: number
  tier?: string
}

export type Snapshot =
  | Map<string, SnapshotEntry | number>
  | Record<string, SnapshotEntry | number>
  | { models?: Map<string, SnapshotEntry> | Record<string, SnapshotEntry> }
  | null
  | undefined

// ---------------------------------------------------------------------------
// Core pure helpers
// ---------------------------------------------------------------------------

/**
 * valueScore = quality / price with free-model fallback.
 * - quality: codingIndex / intelligenceIndex (0..100)
 * - price: total price per 1M tokens (prompt + completion)
 * - price <= 0 or non-finite → 1000 (free / unknown price ranks top on value)
 * - quality non-finite → 0
 * Rounds to 2 decimals to match spec `Math.round(v*100)/100`.
 */
export function valueScore(quality: number, price: number): number {
  const q =
    typeof quality === 'number' && Number.isFinite(quality) ? quality : 0
  const p = typeof price === 'number' && Number.isFinite(price) ? price : 0
  if (p <= 0) return 1000
  if (q <= 0) return 0
  const raw = q / p
  if (!Number.isFinite(raw)) return 1000
  return Math.round(raw * 100) / 100
}

/**
 * Totally free or codingIndex >= 45 is considered worth recommending.
 */
export function isWorthIt(
  codingIndex: number | null | undefined,
  totalPrice: number,
): boolean {
  const price =
    typeof totalPrice === 'number' && Number.isFinite(totalPrice)
      ? totalPrice
      : 0
  if (price === 0) return true
  if (typeof codingIndex !== 'number' || !Number.isFinite(codingIndex))
    return false
  return codingIndex >= 45
}

const TIER_ORDER: Record<string, number> = {
  frontier_coding: 0,
  vision_multimodal: 1,
  fast_agent: 2,
  budget_free: 3,
}

/**
 * Return recommended tier for a model.
 * Mirrors spec: free → budget_free, coding >75 → frontier_coding, else fast_agent.
 * If the model is known to be vision/multimodal and coding is high, callers may
 * map to vision_multimodal externally; here we preserve the 3-tier core.
 */
export function recommendedTier(
  codingIndex: number | null | undefined,
  totalPrice: number,
): Tier {
  const price =
    typeof totalPrice === 'number' && Number.isFinite(totalPrice)
      ? totalPrice
      : 0
  if (price === 0) return 'budget_free'
  if (
    typeof codingIndex === 'number' &&
    Number.isFinite(codingIndex) &&
    codingIndex > 75
  ) {
    return 'frontier_coding'
  }
  return 'fast_agent'
}

/**
 * Rank tiers. Two-arg comparator form: tierRank(a,b) → -1|0|1 semantics via
 * numeric diff (negative means a outranks b). One-arg form returns numeric rank.
 */
export function tierRank(a: string, b?: string): number {
  const ra = TIER_ORDER[a] ?? 99
  if (b === undefined) return ra
  const rb = TIER_ORDER[b] ?? 99
  return ra - rb
}

// ---------------------------------------------------------------------------
// Snapshot helpers (pure, handle multiple snapshot shapes)
// ---------------------------------------------------------------------------

function resolveSnapshotEntry(
  snapshot: Snapshot,
  id: string,
): SnapshotEntry | number | undefined {
  if (!snapshot) return undefined

  // Map<string, ...>
  if (snapshot instanceof Map) {
    const v = (snapshot as Map<string, SnapshotEntry | number>).get(id)
    if (v !== undefined) return v
    // case-insensitive fallback (sync.ts stores by id lowercased in some variants)
    const lower = id.toLowerCase()
    if (lower !== id) {
      const v2 = (snapshot as Map<string, SnapshotEntry | number>).get(lower)
      if (v2 !== undefined) return v2
    }
    return undefined
  }

  // { models: Map|Record }
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'models' in snapshot
  ) {
    const models = (snapshot as { models?: unknown }).models
    if (models instanceof Map) {
      const v = (models as Map<string, SnapshotEntry>).get(id)
      if (v !== undefined) return v
      const v2 = (models as Map<string, SnapshotEntry>).get(id.toLowerCase())
      if (v2 !== undefined) return v2
    } else if (models && typeof models === 'object') {
      const rec = models as Record<string, SnapshotEntry>
      if (id in rec) return rec[id]
      const lower = id.toLowerCase()
      if (lower in rec) return rec[lower]
    }
  }

  // Record<string, ...>
  if (typeof snapshot === 'object' && snapshot !== null) {
    const rec = snapshot as Record<string, SnapshotEntry | number>
    if (id in rec) return rec[id]
    const lower = id.toLowerCase()
    if (lower in rec) return rec[lower]
  }

  return undefined
}

function scoreFromEntry(
  entry: SnapshotEntry | number | undefined,
): number | undefined {
  if (entry === undefined) return undefined
  if (typeof entry === 'number') {
    return Number.isFinite(entry) ? entry : undefined
  }
  if (
    typeof entry.valueScore === 'number' &&
    Number.isFinite(entry.valueScore)
  ) {
    return entry.valueScore
  }
  // derive from quality + price
  const qualityRaw =
    (entry as SnapshotEntry).codingIndex ??
    (entry as SnapshotEntry).intelligenceIndex ??
    (entry as SnapshotEntry).quality ??
    null
  const quality =
    typeof qualityRaw === 'number' && Number.isFinite(qualityRaw)
      ? qualityRaw
      : null
  if (quality === null) return undefined

  const priceRaw =
    typeof (entry as SnapshotEntry).price === 'number'
      ? (entry as SnapshotEntry).price
      : ((entry as SnapshotEntry).pricePer1MInput ?? 0) +
        ((entry as SnapshotEntry).pricePer1MOutput ?? 0)

  const price =
    typeof priceRaw === 'number' && Number.isFinite(priceRaw) ? priceRaw : 0
  return valueScore(quality, price)
}

function tierFromEntry(
  entry: SnapshotEntry | number | undefined,
): string | undefined {
  if (entry === undefined || typeof entry === 'number') return undefined
  if (typeof entry.tier === 'string' && entry.tier.length > 0) return entry.tier
  const coding = (entry as SnapshotEntry).codingIndex ?? null
  const rawPrice = (entry as SnapshotEntry).price
  const price =
    typeof rawPrice === 'number' && Number.isFinite(rawPrice)
      ? rawPrice
      : ((entry as SnapshotEntry).pricePer1MInput ?? 0) +
        ((entry as SnapshotEntry).pricePer1MOutput ?? 0)
  if (typeof coding === 'number' || price === 0) {
    return recommendedTier(coding, price)
  }
  return undefined
}

function candidateId(c: RankCandidate): string {
  if (typeof c === 'string') return c
  const id = (c.model ?? c.id ?? '') as string
  return typeof id === 'string' ? id : ''
}

// ---------------------------------------------------------------------------
// rankCandidates — pure, never mutates input
// ---------------------------------------------------------------------------

/**
 * Rank candidates by valueScore descending, then tier, then stable index.
 * - snapshot: Map<string, SyncedModel> | Record | null; when null/undefined
 *   falls back to static MODEL_REGISTRY scoring (contextWindow/10000) so the
 *   function remains pure and deterministic without network.
 * - Never mutates `candidates`; returns a new array (shallow copy of elements).
 */
export function rankCandidates(
  candidates: ReadonlyArray<RankCandidate>,
  snapshot?: Snapshot,
): RankCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return []

  // shallow copy to avoid mutating input
  const copy = [...candidates]

  const indexed = copy.map((c, idx) => {
    const id = candidateId(c)

    // candidate already carries valueScore? honour it (used by combo tests)
    let score: number | undefined
    if (
      typeof c !== 'string' &&
      typeof (c as Record<string, unknown>).valueScore === 'number'
    ) {
      const vs = (c as Record<string, unknown>).valueScore as number
      if (Number.isFinite(vs)) score = vs
    }
    if (
      score === undefined &&
      typeof c !== 'string' &&
      typeof (c as Record<string, unknown>).score === 'number'
    ) {
      const s = (c as Record<string, unknown>).score as number
      if (Number.isFinite(s)) score = s
    }
    if (
      score === undefined &&
      typeof c !== 'string' &&
      typeof (c as Record<string, unknown>).intelligenceScore === 'number'
    ) {
      const s = (c as Record<string, unknown>).intelligenceScore as number
      if (Number.isFinite(s)) score = s
    }

    if (score === undefined) {
      const entry = resolveSnapshotEntry(snapshot ?? null, id)
      const derived = scoreFromEntry(entry)
      if (derived !== undefined) {
        score = derived
      } else {
        // fallback to static registry scoring
        const spec = MODEL_REGISTRY[id]
        if (spec) {
          // use contextWindow as proxy quality (larger window → higher fallback score)
          // normalized to keep numbers comparable to valueScore (≈ 10-100)
          score = spec.contextWindow / 10_000
        } else {
          score = 0
        }
      }
    }

    const entryForTier = resolveSnapshotEntry(snapshot ?? null, id)
    const tier =
      tierFromEntry(entryForTier) ??
      (typeof c !== 'string'
        ? ((c as Record<string, unknown>).tier as string | undefined)
        : undefined)

    return { c, idx, score: score ?? 0, tier }
  })

  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // tie-break by tier rank if both have tiers
    if (a.tier && b.tier) {
      const tr = tierRank(a.tier, b.tier)
      if (tr !== 0) return tr
    } else if (a.tier && !b.tier) {
      // ranked tier before unranked? put unknown last
      const ra = tierRank(a.tier)
      if (ra !== 99) return -1
    } else if (!a.tier && b.tier) {
      const rb = tierRank(b.tier)
      if (rb !== 99) return 1
    }
    return a.idx - b.idx
  })

  return indexed.map((x) => x.c)
}

// Aliases for doc compatibility (ARCHITECTURE.md lists scoreModel/rankByValue)
export const scoreModel = valueScore
export const rankByValue = rankCandidates
