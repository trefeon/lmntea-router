/**
 * combo.ts — Combo routing strategies (fallback / priority / value-driven)
 *
 * Pure functions: no I/O, no global state, deterministic ordering.
 * Takes candidates + context, returns ordered list.
 * - fallback: sequential (input order), healthy first
 * - priority: weighted descending, least-busy tie-breaker
 * - value-driven: intelligence score descending, least-busy tie-breaker
 *
 * Integrates with circuit breaker via predicate / state map,
 * and with least-busy selection via inFlight counters.
 */

export type ComboStrategy =
  | 'fallback'
  | 'priority'
  | 'value-driven'
  | 'value_driven'
  | 'least-busy'
  | 'p2c'

export interface ComboCandidate {
  model: string
  weight?: number
  priority?: number
  valueScore?: number
  score?: number
  intelligenceScore?: number
  inFlight?: number
}

export interface BreakerStateLike {
  state: 'OPEN' | 'CLOSED' | 'open' | 'closed'
  openedAt?: number | null
  cooldownMs?: number
  failures?: number[]
}

export interface RouteContext {
  strategy: ComboStrategy
  isHealthy?: (model: string) => boolean
  unhealthyModels?: Set<string>
  breakerState?:
    | Map<string, BreakerStateLike>
    | Record<string, BreakerStateLike>
  breaker?: {
    isHealthy?: (model: string) => boolean
    isOpen?: (model: string) => boolean
    getState?: (model: string) => BreakerStateLike | undefined
  }
  scores?: Map<string, number> | Record<string, number>
  intelligenceScores?: Map<string, number> | Record<string, number>
  valueScores?: Map<string, number> | Record<string, number>
  inFlightMap?: Map<string, number> | Record<string, number>
  inFlight?: Map<string, number> | Record<string, number>
  filterUnhealthy?: boolean
}

// ---------------------------------------------------------------------------
// Helpers — pure, no side effects
// ---------------------------------------------------------------------------

function resolveInFlight(
  candidate: ComboCandidate,
  ctx: RouteContext | undefined,
): number {
  if (
    typeof candidate.inFlight === 'number' &&
    Number.isFinite(candidate.inFlight)
  ) {
    return candidate.inFlight
  }
  if (!ctx) return 0
  const map = ctx.inFlightMap ?? ctx.inFlight
  if (!map) return 0
  if (map instanceof Map) {
    const v = map.get(candidate.model)
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const v = (map as Record<string, number>)[candidate.model]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function resolveWeight(candidate: ComboCandidate): number {
  if (
    typeof candidate.weight === 'number' &&
    Number.isFinite(candidate.weight)
  ) {
    return candidate.weight
  }
  if (
    typeof candidate.priority === 'number' &&
    Number.isFinite(candidate.priority)
  ) {
    return candidate.priority
  }
  if (typeof candidate.score === 'number' && Number.isFinite(candidate.score)) {
    return candidate.score
  }
  return 0
}

function resolveValueScore(
  candidate: ComboCandidate,
  ctx: RouteContext | undefined,
): number {
  if (
    typeof candidate.valueScore === 'number' &&
    Number.isFinite(candidate.valueScore)
  ) {
    return candidate.valueScore
  }
  if (typeof candidate.score === 'number' && Number.isFinite(candidate.score)) {
    return candidate.score
  }
  if (
    typeof candidate.intelligenceScore === 'number' &&
    Number.isFinite(candidate.intelligenceScore)
  ) {
    return candidate.intelligenceScore
  }
  if (!ctx) return 0
  const scoreMap = ctx.scores ?? ctx.intelligenceScores ?? ctx.valueScores
  if (!scoreMap) return 0
  if (scoreMap instanceof Map) {
    const v = scoreMap.get(candidate.model)
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const v = (scoreMap as Record<string, number>)[candidate.model]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function resolveHealthy(model: string, ctx: RouteContext | undefined): boolean {
  if (!ctx) return true

  if (ctx.isHealthy) {
    try {
      return ctx.isHealthy(model)
    } catch {
      return true
    }
  }

  if (ctx.breaker?.isHealthy) {
    try {
      return ctx.breaker.isHealthy(model)
    } catch {
      return true
    }
  }

  if (ctx.breaker?.isOpen) {
    try {
      return !ctx.breaker.isOpen(model)
    } catch {
      return true
    }
  }

  if (ctx.breaker?.getState) {
    try {
      const s = ctx.breaker.getState(model)
      if (s && typeof s.state === 'string') {
        const isOpen = s.state === 'OPEN' || s.state === 'open'
        if (!isOpen) return true
        // cooldown check: if openedAt + cooldownMs has passed, treat as healthy (half-open)
        if (
          typeof s.openedAt === 'number' &&
          typeof s.cooldownMs === 'number' &&
          Number.isFinite(s.openedAt) &&
          Number.isFinite(s.cooldownMs)
        ) {
          const now = Date.now()
          if (now - s.openedAt >= s.cooldownMs) return true
        }
        return false
      }
    } catch {
      return true
    }
  }

  if (ctx.unhealthyModels?.has(model)) return false

  if (ctx.breakerState) {
    let state: BreakerStateLike | undefined
    if (ctx.breakerState instanceof Map) {
      state = ctx.breakerState.get(model)
    } else {
      state = (ctx.breakerState as Record<string, BreakerStateLike>)[model]
    }
    if (state && typeof state.state === 'string') {
      const isOpen = state.state === 'OPEN' || state.state === 'open'
      if (!isOpen) return true
      if (
        typeof state.openedAt === 'number' &&
        typeof state.cooldownMs === 'number' &&
        Number.isFinite(state.openedAt) &&
        Number.isFinite(state.cooldownMs)
      ) {
        const now = Date.now()
        if (now - state.openedAt >= state.cooldownMs) return true
      }
      return false
    }
  }

  return true
}

function normalizeStrategy(strategy: string): ComboStrategy {
  const s = strategy.trim().toLowerCase()
  if (s === 'value_driven' || s === 'valuedriven') return 'value-driven'
  if (s === 'least_busy') return 'least-busy'
  return s as ComboStrategy
}

// ---------------------------------------------------------------------------
// Least-busy helper — argmin(in_flight)
// ---------------------------------------------------------------------------

/**
 * Pick the candidate with the smallest inFlight counter.
 * Pure, does not mutate input. Returns undefined for empty input.
 */
export function pickLeastBusy(
  candidates: ComboCandidate[],
  ctx?: Pick<RouteContext, 'inFlight' | 'inFlightMap'>,
): ComboCandidate | undefined {
  if (candidates.length === 0) return undefined
  let best: ComboCandidate | undefined
  let bestFlight = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const flight = resolveInFlight(c, ctx as RouteContext | undefined)
    if (flight < bestFlight) {
      bestFlight = flight
      best = c
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

/**
 * Order candidates according to combo strategy, health, and least-busy tie-breaker.
 *
 * Pure function: never mutates `candidates`, no I/O, deterministic.
 * Healthy candidates always precede unhealthy (circuit breaker integration);
 * within each health partition the strategy dictates ordering, with
 * `inFlight` (least-busy) as the final tie-breaker and original index as
 * stable fallback.
 *
 * @param candidates - model candidates (order matters for fallback)
 * @param context - strategy + optional breaker / scores / inFlight maps
 * @returns new ordered array (shallow copy of input objects)
 */
export function routeCombo(
  candidates: ComboCandidate[],
  context: RouteContext,
): ComboCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  if (!context || typeof context.strategy !== 'string') {
    // default to fallback if no context
    return [...candidates]
  }

  const strategy = normalizeStrategy(context.strategy)

  // Attach index for stable sort, and health flag
  const indexed = candidates.map((c, idx) => ({
    candidate: c,
    idx,
    healthy: resolveHealthy(c.model, context),
    inFlight: resolveInFlight(c, context),
    weight: resolveWeight(c),
    valueScore: resolveValueScore(c, context),
  }))

  const filterUnhealthy = context.filterUnhealthy === true

  let healthyPartition: typeof indexed
  let unhealthyPartition: typeof indexed

  if (filterUnhealthy) {
    healthyPartition = indexed.filter((x) => x.healthy)
    unhealthyPartition = []
  } else {
    healthyPartition = indexed.filter((x) => x.healthy)
    unhealthyPartition = indexed.filter((x) => !x.healthy)
  }

  const sortByStrategy = (arr: typeof indexed): void => {
    if (strategy === 'fallback') {
      // Preserve input order, least-busy only as secondary when explicitly requested?
      // For fallback we keep original index order; inFlight does NOT reorder.
      arr.sort((a, b) => a.idx - b.idx)
      return
    }

    if (strategy === 'priority') {
      arr.sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight
        if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight
        return a.idx - b.idx
      })
      return
    }

    if (strategy === 'value-driven' || strategy === 'value_driven') {
      arr.sort((a, b) => {
        if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore
        if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight
        return a.idx - b.idx
      })
      return
    }

    if (strategy === 'least-busy' || strategy === 'p2c') {
      arr.sort((a, b) => {
        if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight
        // tie-break by weight/valueScore if present
        if (b.weight !== a.weight) return b.weight - a.weight
        if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore
        return a.idx - b.idx
      })
      return
    }

    // unknown strategy -> fallback
    arr.sort((a, b) => a.idx - b.idx)
  }

  sortByStrategy(healthyPartition)
  sortByStrategy(unhealthyPartition)

  const ordered = [...healthyPartition, ...unhealthyPartition].map(
    (x) => x.candidate,
  )

  return ordered
}

/**
 * Overload-friendly alias that accepts single object form:
 * routeCombo({ candidates, strategy, ...ctx }) -> ordered list
 * Kept for ergonomics, not required by spec.
 */
export function routeComboWithConfig(
  config: {
    candidates: ComboCandidate[]
    strategy: ComboStrategy
  } & Omit<RouteContext, 'strategy'>,
): ComboCandidate[] {
  const { candidates, strategy, ...rest } = config
  return routeCombo(candidates, { strategy, ...rest })
}

export default routeCombo
