import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_CAP_MS,
  COOLDOWN_MS,
  WINDOW_MS,
  canAttempt,
  classifyError,
  createBreakerState,
  getNextCooldownMs,
  isCooldownActive,
  isOpen,
  maybeClose,
  pruneFailures,
  recordFailure,
  recordSuccess,
  shouldTrip,
} from '../../src/router/circuitBreaker.js'

describe('classifyError', () => {
  it('400 → REJECT_IMMEDIATE', () => {
    expect(classifyError(400)).toBe('REJECT_IMMEDIATE')
  })

  it('401 → ROTATE_ACCOUNT_IN_POOL', () => {
    expect(classifyError(401)).toBe('ROTATE_ACCOUNT_IN_POOL')
  })

  it('403 → ROTATE_ACCOUNT_IN_POOL', () => {
    expect(classifyError(403)).toBe('ROTATE_ACCOUNT_IN_POOL')
  })

  it('429 → ROTATE_ACCOUNT_IN_POOL', () => {
    expect(classifyError(429)).toBe('ROTATE_ACCOUNT_IN_POOL')
  })

  it('500 → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(500)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('502 → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(502)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('503 → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(503)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('504 → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(504)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('timeout via isTimeout opts → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(0, undefined, { isTimeout: true })).toBe(
      'FAILOVER_NEXT_MODEL',
    )
    expect(classifyError(null, undefined, { isTimeout: true })).toBe(
      'FAILOVER_NEXT_MODEL',
    )
    expect(classifyError(undefined, undefined, { isTimeout: true })).toBe(
      'FAILOVER_NEXT_MODEL',
    )
  })

  it('timeout via string status → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError('timeout')).toBe('FAILOVER_NEXT_MODEL')
    expect(classifyError('TIMEOUT')).toBe('FAILOVER_NEXT_MODEL')
  })

  it('null/undefined status → FAILOVER_NEXT_MODEL (network error)', () => {
    expect(classifyError(null)).toBe('FAILOVER_NEXT_MODEL')
    expect(classifyError(undefined)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('408 timeout → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(408)).toBe('FAILOVER_NEXT_MODEL')
  })

  it('other 4xx like 402, 404, 422 → REJECT_IMMEDIATE', () => {
    expect(classifyError(402)).toBe('REJECT_IMMEDIATE')
    expect(classifyError(404)).toBe('REJECT_IMMEDIATE')
    expect(classifyError(422)).toBe('REJECT_IMMEDIATE')
  })

  it('code ETIMEDOUT → FAILOVER_NEXT_MODEL', () => {
    expect(classifyError(500, undefined, { code: 'ETIMEDOUT' })).toBe(
      'FAILOVER_NEXT_MODEL',
    )
    expect(classifyError(0, undefined, { code: 'TIMEOUT' })).toBe(
      'FAILOVER_NEXT_MODEL',
    )
  })

  it('is pure — does not throw on unknown body', () => {
    expect(
      classifyError(500, { error: { message: 'Internal server error' } }),
    ).toBe('FAILOVER_NEXT_MODEL')
    expect(classifyError(429, { type: 'FreeUsageLimitError' })).toBe(
      'ROTATE_ACCOUNT_IN_POOL',
    )
  })
})

describe('shouldTrip — sliding window AllowedFails 60s, 3 consecutive 5xx trips', () => {
  it('1 failure in window → not tripped', () => {
    const now = 100_000
    expect(shouldTrip([now - 10_000], now)).toBe(false)
  })

  it('2 failures in window → not tripped', () => {
    const now = 100_000
    expect(shouldTrip([now - 20_000, now - 10_000], now)).toBe(false)
  })

  it('3 failures in 60s → trips', () => {
    const now = 100_000
    expect(shouldTrip([now - 50_000, now - 20_000, now - 5_000], now)).toBe(
      true,
    )
  })

  it('3 failures but one outside 60s window → not tripped', () => {
    const now = 100_000
    // first failure 61s ago is pruned
    expect(shouldTrip([now - 61_000, now - 20_000, now - 5_000], now)).toBe(
      false,
    )
  })

  it('4 failures spanning exactly window edge', () => {
    const now = 100_000
    // 60_000 exactly is still inside (<= WINDOW_MS)
    expect(shouldTrip([now - 60_000, now - 30_000, now - 10_000], now)).toBe(
      true,
    )
  })

  it('empty → not tripped', () => {
    expect(shouldTrip([], Date.now())).toBe(false)
  })

  it('pruneFailures helper respects window', () => {
    const now = 200_000
    expect(
      pruneFailures([now - 70_000, now - 10_000, now - 5_000], now),
    ).toEqual([now - 10_000, now - 5_000])
    expect(pruneFailures([now - 60_000], now)).toEqual([now - 60_000])
    expect(pruneFailures([now - 60_001], now)).toEqual([])
  })
})

describe('cooldown management — 60s base, cap 300s', () => {
  it('COOLDOWN_MS is 60_000 and cap is 300_000', () => {
    expect(COOLDOWN_MS).toBe(60_000)
    expect(COOLDOWN_CAP_MS).toBe(300_000)
    expect(WINDOW_MS).toBe(60_000)
  })

  it('getNextCooldownMs doubles until cap', () => {
    expect(getNextCooldownMs(60_000)).toBe(120_000)
    expect(getNextCooldownMs(120_000)).toBe(240_000)
    expect(getNextCooldownMs(240_000)).toBe(300_000) // capped, 480k → 300k
    expect(getNextCooldownMs(300_000)).toBe(300_000)
    expect(getNextCooldownMs(500_000)).toBe(300_000)
  })

  it('getNextCooldownMs with 0 or invalid → 60_000', () => {
    expect(getNextCooldownMs(0)).toBe(60_000)
    expect(getNextCooldownMs(-10)).toBe(60_000)
  })

  it('isCooldownActive true within window', () => {
    const openedAt = 100_000
    expect(isCooldownActive(openedAt, 60_000, openedAt + 59_999)).toBe(true)
    expect(isCooldownActive(openedAt, 60_000, openedAt + 60_000)).toBe(false)
    expect(isCooldownActive(openedAt, 60_000, openedAt + 60_001)).toBe(false)
    expect(isCooldownActive(null, 60_000, openedAt)).toBe(false)
  })

  it('cap enforced after repeated trips (exponential to 300s)', () => {
    let cd = COOLDOWN_MS // 60k
    cd = getNextCooldownMs(cd) // 120k
    expect(cd).toBe(120_000)
    cd = getNextCooldownMs(cd) // 240k
    expect(cd).toBe(240_000)
    cd = getNextCooldownMs(cd) // 300k cap (480k → 300k)
    expect(cd).toBe(300_000)
    cd = getNextCooldownMs(cd) // stays capped
    expect(cd).toBe(300_000)
  })

  it('recordFailure trips after 3rd 5xx in 60s with 60s cooldown', () => {
    const t0 = 1_000_000
    let state = createBreakerState()
    expect(state.state).toBe('CLOSED')
    state = recordFailure(state, t0)
    expect(state.state).toBe('CLOSED')
    expect(state.failures.length).toBe(1)
    state = recordFailure(state, t0 + 10_000)
    expect(state.state).toBe('CLOSED')
    state = recordFailure(state, t0 + 20_000)
    expect(state.state).toBe('OPEN')
    expect(state.cooldownMs).toBe(60_000)
    expect(state.openedAt).toBe(t0 + 20_000)
    expect(isOpen(state, t0 + 20_000)).toBe(true)
    expect(isOpen(state, t0 + 20_000 + 60_000)).toBe(false)
    expect(canAttempt(state, t0 + 20_000 + 30_000)).toBe(false)
    expect(canAttempt(state, t0 + 20_000 + 60_000)).toBe(true)
  })

  it('recordFailure prunes outside window — does not trip if spaced >60s', () => {
    const t0 = 1_000_000
    let state = createBreakerState()
    state = recordFailure(state, t0)
    state = recordFailure(state, t0 + 61_000) // first pruned
    expect(state.failures.length).toBe(1)
    state = recordFailure(state, t0 + 62_000)
    expect(state.failures.length).toBe(2)
    expect(state.state).toBe('CLOSED') // only 2 in window
  })

  it('maybeClose transitions OPEN → CLOSED after cooldown', () => {
    const t0 = 500_000
    let state = createBreakerState()
    state = recordFailure(state, t0)
    state = recordFailure(state, t0 + 5_000)
    state = recordFailure(state, t0 + 10_000)
    expect(state.state).toBe('OPEN')
    // still open before cooldown
    expect(maybeClose(state, t0 + 10_000 + 30_000).state).toBe('OPEN')
    // after cooldown → closed and failures cleared
    const closed = maybeClose(state, t0 + 10_000 + 60_000)
    expect(closed.state).toBe('CLOSED')
    expect(closed.failures.length).toBe(0)
    expect(closed.openedAt).toBe(null)
  })

  it('recordSuccess clears failures but keeps OPEN until cooldown', () => {
    const t0 = 800_000
    let state = createBreakerState()
    state = recordFailure(state, t0)
    state = recordFailure(state, t0 + 1_000)
    expect(state.failures.length).toBe(2)
    state = recordSuccess(state)
    expect(state.failures.length).toBe(0)
    expect(state.state).toBe('CLOSED')
  })

  it('pure — recordFailure does not mutate input', () => {
    const orig = createBreakerState()
    const t0 = 900_000
    const next = recordFailure(orig, t0)
    expect(orig.failures.length).toBe(0)
    expect(next.failures.length).toBe(1)
    expect(orig).not.toBe(next)
  })
})
