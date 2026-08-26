/**
 * circuitBreaker.ts — error classifier + sliding-window breaker + cooldown
 *
 * Pure functions, no I/O, no timers, no global state.
 * All time is caller-supplied `now` (Date.now() ms) for hermetic testing.
 *
 * Failure taxonomy (docs/ARCHITECTURE.md:37 + devdocs/01-ARCHITECTURE.md:5):
 *  - 400               → REJECT_IMMEDIATE (no retry, no cooldown, no breaker increment)
 *  - 401 / 403 / 429   → ROTATE_ACCOUNT_IN_POOL (disable key 60s, retry same model next key)
 *  - 5xx / 504 / timeout / stall → FAILOVER_NEXT_MODEL (next combo candidate, increment breaker window)
 *  - 3× FAILOVER in 60s sliding window → CIRCUIT_BREAK_PROVIDER (cooldown 60s, cap 300s)
 *
 * Only FAILOVER increments the 60s ring buffer. 400 and 429 never increment.
 */

export const WINDOW_MS = 60_000
export const TRIP_THRESHOLD = 3
export const COOLDOWN_MS = 60_000
export const COOLDOWN_CAP_MS = 300_000

export type ErrorAction =
  | 'REJECT_IMMEDIATE'
  | 'ROTATE_ACCOUNT_IN_POOL'
  | 'FAILOVER_NEXT_MODEL'
  | 'CIRCUIT_BREAK_PROVIDER'

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** explicit timeout signal (AbortError, stall watchdog, relay watchdog) */
  isTimeout?: boolean
  /** optional error code string e.g. 'TIMEOUT' | 'ETIMEDOUT' | 'ECONNRESET' */
  code?: string
}

/**
 * Pure error classifier.
 *
 * @param status - HTTP status code; null/undefined treated as network/timeout → FAILOVER
 * @param _body - optional upstream body (reserved for future sniffing, currently ignored beyond status)
 * @param opts - optional timeout/code hint
 */
export function classifyError(
  status: number | string | null | undefined,
  _body?: unknown,
  opts?: ClassifyOptions,
): ErrorAction {
  // explicit timeout signal takes precedence
  if (opts?.isTimeout) return 'FAILOVER_NEXT_MODEL'
  if (opts?.code) {
    const c = opts.code.toUpperCase()
    if (
      c === 'TIMEOUT' ||
      c === 'ETIMEDOUT' ||
      c === 'ECONNRESET' ||
      c === 'ECONNREFUSED' ||
      c === 'ABORT_ERR' ||
      c === 'ABORTED'
    ) {
      return 'FAILOVER_NEXT_MODEL'
    }
  }

  // normalize status to numeric code
  let code: number | null = null
  if (typeof status === 'string') {
    const s = status.toLowerCase()
    if (s === 'timeout' || s === 'abort' || s === 'stall')
      return 'FAILOVER_NEXT_MODEL'
    const n = Number(status)
    if (Number.isNaN(n)) return 'FAILOVER_NEXT_MODEL'
    code = n
  } else if (status === null || status === undefined) {
    return 'FAILOVER_NEXT_MODEL'
  } else {
    code = status
  }

  // 401 / 403 / 429 → rotate key (per-key quota, not provider health)
  if (code === 401 || code === 403 || code === 429)
    return 'ROTATE_ACCOUNT_IN_POOL'

  // 408 is timeout → failover (must check before generic 4xx)
  if (code === 408) return 'FAILOVER_NEXT_MODEL'

  // 400 family excluding rotate already handled → reject
  if (code >= 400 && code < 500) {
    return 'REJECT_IMMEDIATE'
  }

  // 5xx → failover to next combo candidate
  if (code >= 500 && code <= 599) return 'FAILOVER_NEXT_MODEL'

  // unknown → failover (mermaid: UNKNOWN → classify as 5xx + log + failover)
  return 'FAILOVER_NEXT_MODEL'
}

// ---------------------------------------------------------------------------
// Sliding window — AllowedFails policy
// ---------------------------------------------------------------------------

/**
 * Prune failures outside the 60s sliding window.
 * Pure helper — exported for testing.
 */
export function pruneFailures(failures: number[], now: number): number[] {
  return failures.filter((ts) => now - ts >= 0 && now - ts <= WINDOW_MS)
}

/**
 * Whether the breaker should trip.
 * Sliding window 60s, trip after 3 consecutive 5xx (i.e. 3 FAILOVER entries in window).
 * Only FAILOVER increments the window — caller must only push 5xx/timeout timestamps.
 */
export function shouldTrip(failures: number[], now: number): boolean {
  const windowed = pruneFailures(failures, now)
  return windowed.length >= TRIP_THRESHOLD
}

// ---------------------------------------------------------------------------
// Cooldown management — pure, no timers
// ---------------------------------------------------------------------------

export interface BreakerState {
  failures: number[]
  state: 'CLOSED' | 'OPEN'
  openedAt: number | null
  cooldownMs: number
}

export function createBreakerState(): BreakerState {
  return {
    failures: [],
    state: 'CLOSED',
    openedAt: null,
    // 0 → first trip escalates via getNextCooldownMs(0) = COOLDOWN_MS (60s);
    // subsequent trips double: 120s, 240s, 300s cap.
    cooldownMs: 0,
  }
}

/**
 * Next cooldown with exponential backoff, capped at 300s.
 * First trip → 60s, then 120s, 240s, 300s cap.
 */
export function getNextCooldownMs(currentMs: number): number {
  if (!Number.isFinite(currentMs) || currentMs <= 0) return COOLDOWN_MS
  const doubled = currentMs * 2
  return doubled > COOLDOWN_CAP_MS ? COOLDOWN_CAP_MS : doubled
}

/**
 * Whether cooldown is still active.
 */
export function isCooldownActive(
  openedAt: number | null,
  cooldownMs: number,
  now: number,
): boolean {
  if (openedAt === null) return false
  return now - openedAt < cooldownMs
}

/**
 * Whether the breaker is open and still in cooldown (i.e. should block attempts).
 */
export function isOpen(state: BreakerState, now: number): boolean {
  if (state.state !== 'OPEN') return false
  return isCooldownActive(state.openedAt, state.cooldownMs, now)
}

/**
 * Whether a request may attempt the provider (closed, or open but cooldown elapsed).
 */
export function canAttempt(state: BreakerState, now: number): boolean {
  return !isOpen(state, now)
}

/**
 * Return state transitioned to CLOSED if cooldown elapsed; otherwise unchanged.
 * Pure — returns new object if changed, same reference if not? We return new object for purity.
 */
export function maybeClose(state: BreakerState, now: number): BreakerState {
  if (
    state.state === 'OPEN' &&
    !isCooldownActive(state.openedAt, state.cooldownMs, now)
  ) {
    return {
      failures: [],
      state: 'CLOSED',
      openedAt: null,
      cooldownMs: state.cooldownMs,
    }
  }
  return state
}

/**
 * Record a failure (5xx/timeout) at `now`.
 * - Prunes old failures outside 60s window
 * - Appends `now` if action is FAILOVER (caller should guard; we always record when called)
 * - Checks shouldTrip → if tripping and currently CLOSED, transitions to OPEN with next cooldown
 * Pure — never mutates input.
 */
export function recordFailure(state: BreakerState, now: number): BreakerState {
  const pruned = pruneFailures(state.failures, now)
  const nextFailures = [...pruned, now]

  // Re-arm an OPEN breaker whose cooldown already elapsed — callers that skip
  // maybeClose (canAttempt-only polling) must still be able to re-trip.
  const effective =
    state.state === 'OPEN' &&
    !isCooldownActive(state.openedAt, state.cooldownMs, now)
      ? ({ ...state, state: 'CLOSED', openedAt: null } as BreakerState)
      : state

  if (shouldTrip(nextFailures, now) && effective.state === 'CLOSED') {
    // cooldownMs carries the previous period's cooldown; escalate 60→120→240→300.
    const capped = Math.min(
      getNextCooldownMs(effective.cooldownMs),
      COOLDOWN_CAP_MS,
    )
    return {
      failures: nextFailures,
      state: 'OPEN',
      openedAt: now,
      cooldownMs: capped,
    }
  }

  if (effective.state === 'OPEN') {
    return {
      ...effective,
      failures: nextFailures,
    }
  }

  return {
    ...effective,
    failures: nextFailures,
  }
}

/**
 * Record a success — clears the failure window.
 * Pure.
 */
export function recordSuccess(state: BreakerState): BreakerState {
  if (state.failures.length === 0 && state.state === 'CLOSED') return state
  return {
    ...state,
    failures: [],
  }
}
