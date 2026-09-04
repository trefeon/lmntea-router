import { beforeEach, describe, expect, it } from 'vitest'
import {
  USAGE_PERIODS,
  type UsageSummary,
  recordUsage,
  resetUsageForTests,
  summarizeUsage,
} from '../../src/observability/usage.js'

describe('usage recorder', () => {
  beforeEach(() => {
    resetUsageForTests()
  })

  it('exports the supported periods and returns an honest empty summary', () => {
    expect(USAGE_PERIODS).toEqual(['24h', '7d', '30d'])
    expect(summarizeUsage('24h', 1_000_000)).toEqual<UsageSummary>({
      requests: 0,
      errors: 0,
      tokensIn: null,
      tokensOut: null,
      cost: null,
      avgLatencyMs: null,
      avgTtftMs: null,
      p95Ms: null,
      cacheHit: null,
      points: [],
      byModel: [],
    })
  })

  it('filters records at the inclusive period boundary and counts errors', () => {
    const now = Date.UTC(2026, 8, 4, 12)
    const day = 24 * 60 * 60 * 1000
    recordUsage({
      at: now - day,
      model: 'boundary',
      status: 200,
      durationMs: 10,
    })
    recordUsage({
      at: now - day - 1,
      model: 'old',
      status: 500,
      durationMs: 20,
    })
    recordUsage({ at: now, model: 'current', status: 499, durationMs: 30 })

    const summary = summarizeUsage('24h', now)
    expect(summary.requests).toBe(2)
    expect(summary.errors).toBe(1)
    expect(summary.byModel.map(({ model }) => model)).toEqual([
      'boundary',
      'current',
    ])
  })

  it('aggregates optional metrics without confusing zero with unknown', () => {
    const now = Date.UTC(2026, 8, 4, 12)
    recordUsage({
      at: now,
      model: 'alpha',
      status: 200,
      durationMs: 10,
      tokensIn: 0,
      tokensOut: 20,
      cost: 0,
      ttftMs: 0,
      cacheHit: true,
    })
    recordUsage({
      at: now + 1,
      model: 'alpha',
      status: 200,
      durationMs: 30,
      tokensIn: 5,
      tokensOut: 0,
      cost: 1.5,
      ttftMs: 10,
      cacheHit: false,
    })

    expect(summarizeUsage('24h', now)).toMatchObject({
      tokensIn: 5,
      tokensOut: 20,
      cost: 1.5,
      avgLatencyMs: 20,
      avgTtftMs: 5,
      p95Ms: 30,
      cacheHit: 0.5,
    })

    recordUsage({ at: now, model: 'unknown', status: 200, durationMs: 1 })
    const model = summarizeUsage('24h', now).byModel.find(
      (item) => item.model === 'unknown',
    )
    expect(model).toMatchObject({ tokens: null, ttftMs: null, cost: null })
  })

  it('groups by model, uses request-count descending order, and calculates shares', () => {
    const now = Date.UTC(2026, 8, 4, 12)
    recordUsage({
      at: now,
      model: 'zeta',
      status: 200,
      durationMs: 5,
      tokensIn: 1,
      tokensOut: 2,
    })
    recordUsage({
      at: now,
      model: 'alpha',
      status: 200,
      durationMs: 5,
      tokensIn: 3,
    })
    recordUsage({
      at: now,
      model: 'alpha',
      status: 200,
      durationMs: 5,
      tokensOut: 4,
    })

    const byModel = summarizeUsage('24h', now).byModel
    expect(byModel).toMatchObject([
      { model: 'alpha', req: 2, tokens: 7, ttftMs: null, cost: null },
      { model: 'zeta', req: 1, tokens: 3, ttftMs: null, cost: null },
    ])
    expect(byModel[0]?.share).toBeCloseTo((2 / 3) * 100, 10)
    expect(byModel[1]?.share).toBeCloseTo((1 / 3) * 100, 10)
  })

  it('creates ascending UTC-hour points with nullable token totals', () => {
    const hour = 60 * 60 * 1000
    const now = Date.UTC(2026, 8, 4, 12, 30)
    recordUsage({ at: now - hour, model: 'a', status: 200, durationMs: 1 })
    recordUsage({
      at: now - hour + 1,
      model: 'b',
      status: 200,
      durationMs: 1,
      tokensIn: 2,
      tokensOut: 3,
    })
    recordUsage({
      at: now,
      model: 'a',
      status: 200,
      durationMs: 1,
      tokensOut: 0,
    })

    expect(summarizeUsage('24h', now).points).toEqual([
      { t: '2026-09-04T11:00:00.000Z', requests: 2, tokens: 5 },
      { t: '2026-09-04T12:00:00.000Z', requests: 1, tokens: 0 },
    ])
  })

  it('retains only the newest 10,000 records', () => {
    const now = Date.UTC(2026, 8, 4, 12)
    for (let index = 0; index < 10_001; index += 1) {
      recordUsage({
        at: now,
        model: index === 10_000 ? 'newest' : 'old',
        status: 200,
        durationMs: 1,
      })
    }

    const summary = summarizeUsage('24h', now)
    expect(summary.requests).toBe(10_000)
    expect(summary.byModel.find(({ model }) => model === 'newest')?.req).toBe(1)
  })
})
