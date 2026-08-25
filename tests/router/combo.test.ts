import { describe, expect, it, vi } from 'vitest'
import {
  type ComboCandidate,
  pickLeastBusy,
  routeCombo,
} from '../../src/router/combo.js'

// helpers to create candidates quickly
function c(model: string, opts: Partial<ComboCandidate> = {}): ComboCandidate {
  return { model, ...opts }
}

describe('routeCombo — fallback (sequential)', () => {
  it('preserves input order for healthy candidates', () => {
    const candidates = [c('a'), c('b'), c('c')]
    const ordered = routeCombo(candidates, { strategy: 'fallback' })
    expect(ordered.map((x) => x.model)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate input array', () => {
    const candidates = [c('a'), c('b')]
    const copy = [...candidates]
    routeCombo(candidates, { strategy: 'fallback' })
    expect(candidates).toEqual(copy)
  })

  it('empty candidates returns empty array', () => {
    expect(routeCombo([], { strategy: 'fallback' })).toEqual([])
  })
})

describe('routeCombo — priority (weighted)', () => {
  it('sorts by weight descending', () => {
    const candidates = [
      c('low', { weight: 1 }),
      c('high', { weight: 10 }),
      c('mid', { weight: 5 }),
    ]
    const ordered = routeCombo(candidates, { strategy: 'priority' })
    expect(ordered.map((x) => x.model)).toEqual(['high', 'mid', 'low'])
  })

  it('supports priority alias field', () => {
    const candidates = [c('a', { priority: 2 }), c('b', { priority: 9 })]
    const ordered = routeCombo(candidates, { strategy: 'priority' })
    expect(ordered[0]?.model).toBe('b')
  })

  it('tie-breaks by least-busy (inFlight) when weights equal', () => {
    const candidates = [
      c('a', { weight: 5, inFlight: 10 }),
      c('b', { weight: 5, inFlight: 1 }),
      c('c', { weight: 5, inFlight: 3 }),
    ]
    const ordered = routeCombo(candidates, { strategy: 'priority' })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'c', 'a'])
  })

  it('uses inFlightMap when candidate lacks inFlight', () => {
    const candidates = [c('a', { weight: 5 }), c('b', { weight: 5 })]
    const inFlightMap = new Map<string, number>([
      ['a', 7],
      ['b', 2],
    ])
    const ordered = routeCombo(candidates, {
      strategy: 'priority',
      inFlightMap,
    })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'a'])
  })
})

describe('routeCombo — value-driven (intelligence score)', () => {
  it('sorts by valueScore descending', () => {
    const candidates = [
      c('a', { valueScore: 10 }),
      c('b', { valueScore: 40 }),
      c('c', { valueScore: 25 }),
    ]
    const ordered = routeCombo(candidates, { strategy: 'value-driven' })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'c', 'a'])
  })

  it('supports score/intelligenceScore aliases', () => {
    const candidates = [c('a', { score: 5 }), c('b', { intelligenceScore: 20 })]
    const ordered = routeCombo(candidates, { strategy: 'value-driven' })
    expect(ordered[0]?.model).toBe('b')
  })

  it('tie-breaks value-driven by least-busy', () => {
    const candidates = [
      c('a', { valueScore: 10, inFlight: 5 }),
      c('b', { valueScore: 10, inFlight: 1 }),
    ]
    const ordered = routeCombo(candidates, { strategy: 'value-driven' })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'a'])
  })

  it('uses intelligenceScores map from context when candidate lacks score', () => {
    const candidates = [c('a'), c('b'), c('c')]
    const scores = new Map<string, number>([
      ['a', 10],
      ['b', 99],
      ['c', 50],
    ])
    const ordered = routeCombo(candidates, {
      strategy: 'value-driven',
      intelligenceScores: scores,
    })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'c', 'a'])
  })

  it('uses scores alias map', () => {
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(candidates, {
      strategy: 'value-driven',
      scores: { a: 1, b: 100 },
    })
    expect(ordered[0]?.model).toBe('b')
  })

  it('accepts value_driven underscore variant', () => {
    const candidates = [c('a', { valueScore: 1 }), c('b', { valueScore: 2 })]
    const ordered = routeCombo(candidates, {
      strategy: 'value_driven' as unknown as 'value-driven',
    })
    expect(ordered[0]?.model).toBe('b')
  })
})

describe('routeCombo — circuit breaker integration', () => {
  it('moves unhealthy models to end via unhealthyModels Set (fallback)', () => {
    const candidates = [c('a'), c('b'), c('c')]
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      unhealthyModels: new Set(['a']),
    })
    // healthy b,c first in input order, then unhealthy a
    expect(ordered.map((x) => x.model)).toEqual(['b', 'c', 'a'])
  })

  it('moves OPEN breakerState models to end and sorts within partitions', () => {
    const candidates = [
      c('a', { weight: 10 }),
      c('b', { weight: 5 }),
      c('c', { weight: 8 }),
    ]
    const breakerState = new Map([
      [
        'b',
        { state: 'OPEN' as const, openedAt: Date.now(), cooldownMs: 60_000 },
      ],
      ['a', { state: 'CLOSED' as const }],
      ['c', { state: 'CLOSED' as const }],
    ])
    const ordered = routeCombo(candidates, {
      strategy: 'priority',
      breakerState,
    })
    // healthy a(10), c(8) first sorted by weight, then unhealthy b last
    expect(ordered.map((x) => x.model)).toEqual(['a', 'c', 'b'])
  })

  it('treats expired cooldown as healthy (half-open)', () => {
    const now = Date.now()
    const candidates = [c('a'), c('b')]
    // a tripped 70s ago with 60s cooldown -> should be considered healthy now
    const breakerState: Record<
      string,
      { state: 'OPEN' | 'CLOSED'; openedAt: number | null; cooldownMs: number }
    > = {
      a: { state: 'OPEN', openedAt: now - 70_000, cooldownMs: 60_000 },
      b: { state: 'CLOSED', openedAt: null, cooldownMs: 60_000 },
    }
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      breakerState,
    })
    // both healthy now, preserve input order
    expect(ordered.map((x) => x.model)).toEqual(['a', 'b'])
  })

  it('treats active cooldown as unhealthy', () => {
    const now = Date.now()
    const candidates = [c('a'), c('b')]
    const breakerState = new Map([
      [
        'a',
        { state: 'OPEN' as const, openedAt: now - 10_000, cooldownMs: 60_000 },
      ],
    ])
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      breakerState,
    })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'a'])
  })

  it('uses isHealthy predicate when provided', () => {
    const candidates = [c('a'), c('b'), c('c')]
    const ordered = routeCombo(candidates, {
      strategy: 'value-driven',
      isHealthy: (m) => m !== 'b',
    })
    // a,c healthy first, b unhealthy last
    expect(ordered[ordered.length - 1]?.model).toBe('b')
  })

  it('uses breaker.isHealthy when provided', () => {
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      breaker: { isHealthy: (m) => m === 'b' },
    })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'a'])
  })

  it('uses breaker.getState when provided', () => {
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      breaker: {
        getState: (m) =>
          m === 'a'
            ? { state: 'OPEN', openedAt: Date.now(), cooldownMs: 60_000 }
            : { state: 'CLOSED', openedAt: null, cooldownMs: 60_000 },
      },
    })
    expect(ordered[0]?.model).toBe('b')
  })

  it('filterUnhealthy removes unhealthy instead of deprioritizing', () => {
    const candidates = [c('a'), c('b'), c('c')]
    const ordered = routeCombo(candidates, {
      strategy: 'fallback',
      unhealthyModels: new Set(['a', 'b']),
      filterUnhealthy: true,
    })
    expect(ordered.map((x) => x.model)).toEqual(['c'])
  })

  it('healthy partition also respects strategy sorting after breaker filter (priority + breaker + least-busy)', () => {
    const candidates = [
      c('a', { weight: 10, inFlight: 5 }),
      c('b', { weight: 10, inFlight: 1 }),
      c('c', { weight: 5, inFlight: 0 }),
    ]
    const ordered = routeCombo(candidates, {
      strategy: 'priority',
      unhealthyModels: new Set(['c']),
    })
    // healthy a,b sorted by weight equal -> least-busy b before a, then unhealthy c
    expect(ordered.map((x) => x.model)).toEqual(['b', 'a', 'c'])
  })
})

describe('routeCombo — least-busy selection', () => {
  it('pickLeastBusy returns argmin(inFlight)', () => {
    const candidates = [
      c('a', { inFlight: 5 }),
      c('b', { inFlight: 1 }),
      c('c', { inFlight: 3 }),
    ]
    const picked = pickLeastBusy(candidates)
    expect(picked?.model).toBe('b')
  })

  it('pickLeastBusy uses inFlightMap', () => {
    const candidates = [c('a'), c('b')]
    const picked = pickLeastBusy(candidates, {
      inFlightMap: new Map([
        ['a', 10],
        ['b', 2],
      ]),
    })
    expect(picked?.model).toBe('b')
  })

  it('pickLeastBusy returns undefined for empty', () => {
    expect(pickLeastBusy([])).toBeUndefined()
  })

  it('routeCombo with least-busy strategy sorts by inFlight ascending', () => {
    const candidates = [
      c('a', { inFlight: 5 }),
      c('b', { inFlight: 1 }),
      c('c', { inFlight: 3 }),
    ]
    const ordered = routeCombo(candidates, { strategy: 'least-busy' })
    expect(ordered.map((x) => x.model)).toEqual(['b', 'c', 'a'])
  })

  it('routeCombo least-busy also respects breaker health partition', () => {
    const candidates = [c('a', { inFlight: 1 }), c('b', { inFlight: 0 })]
    const ordered = routeCombo(candidates, {
      strategy: 'least-busy',
      unhealthyModels: new Set(['b']),
    })
    // b is unhealthy despite lower inFlight, so a (healthy) first
    expect(ordered.map((x) => x.model)).toEqual(['a', 'b'])
  })

  it('routeCombo p2c alias behaves like least-busy', () => {
    const candidates = [c('a', { inFlight: 9 }), c('b', { inFlight: 2 })]
    const ordered = routeCombo(candidates, { strategy: 'p2c' })
    expect(ordered[0]?.model).toBe('b')
  })
})

describe('routeCombo — edge & purity', () => {
  it('is pure — does not mutate candidate objects', () => {
    const candidates = [c('a', { weight: 5 })]
    const snapshot = JSON.stringify(candidates)
    routeCombo(candidates, { strategy: 'priority' })
    expect(JSON.stringify(candidates)).toBe(snapshot)
  })

  it('handles missing strategy gracefully (returns copy of input)', () => {
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(
      candidates,
      {} as unknown as { strategy: 'fallback' },
    )
    expect(ordered.map((x) => x.model)).toEqual(['a', 'b'])
  })

  it('uses fallback for unknown strategy', () => {
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(candidates, {
      // @ts-expect-error unknown
      strategy: 'unknown-strategy',
    })
    expect(ordered.map((x) => x.model)).toEqual(['a', 'b'])
  })

  it('value-driven with record map scores works', () => {
    vi.useFakeTimers()
    const candidates = [c('a'), c('b')]
    const ordered = routeCombo(candidates, {
      strategy: 'value-driven',
      scores: { a: 5, b: 50 },
    })
    expect(ordered[0]?.model).toBe('b')
    vi.useRealTimers()
  })
})
