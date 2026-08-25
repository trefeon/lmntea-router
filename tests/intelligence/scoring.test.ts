import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'
import {
  isWorthIt,
  rankCandidates,
  recommendedTier,
  tierRank,
  valueScore,
} from '../../src/intelligence/scoring.js'

describe('intelligence/scoring — valueScore', () => {
  it('quality/price basic division (80/20 → 4.0)', () => {
    expect(valueScore(80, 20)).toBe(4)
  })

  it('free model price 0 → fallback 1000', () => {
    expect(valueScore(77, 0)).toBe(1000)
    expect(valueScore(77, -5)).toBe(1000)
    expect(valueScore(60, 0)).toBe(1000)
  })

  it('rounds to 2 decimals (10/3 → 3.33)', () => {
    expect(valueScore(10, 3)).toBe(3.33)
    expect(valueScore(77, 3)).toBe(25.67)
  })

  it('handles non-finite / NaN gracefully', () => {
    expect(valueScore(Number.NaN, 10)).toBe(0)
    expect(valueScore(50, Number.NaN)).toBe(1000)
    expect(valueScore(Number.POSITIVE_INFINITY, 10)).toBe(0)
    expect(valueScore(50, Number.POSITIVE_INFINITY)).toBe(1000)
  })

  it('quality 0 → 0 even with price >0', () => {
    expect(valueScore(0, 10)).toBe(0)
    expect(valueScore(0, 0)).toBe(1000)
  })

  it('real pricing: 77 / (1+2)=25.67 and 80/20=4', () => {
    // mimics sync.ts: pricePer1MInput 1, pricePer1MOutput 2 → total 3
    expect(valueScore(77, 3)).toBe(25.67)
    expect(valueScore(80, 20)).toBe(4)
  })
})

describe('intelligence/scoring — tier helpers', () => {
  it('recommendedTier: free → budget_free', () => {
    expect(recommendedTier(10, 0)).toBe('budget_free')
    expect(recommendedTier(null, 0)).toBe('budget_free')
    expect(recommendedTier(90, 0)).toBe('budget_free')
  })

  it('recommendedTier: coding >75 + price>0 → frontier_coding', () => {
    expect(recommendedTier(80, 10)).toBe('frontier_coding')
    expect(recommendedTier(76, 5)).toBe('frontier_coding')
  })

  it('recommendedTier: coding <=75 + price>0 → fast_agent', () => {
    expect(recommendedTier(75, 10)).toBe('fast_agent')
    expect(recommendedTier(50, 10)).toBe('fast_agent')
    expect(recommendedTier(null, 10)).toBe('fast_agent')
  })

  it('isWorthIt: free always true, coding >=45 true', () => {
    expect(isWorthIt(null, 0)).toBe(true)
    expect(isWorthIt(30, 0)).toBe(true)
    expect(isWorthIt(45, 10)).toBe(true)
    expect(isWorthIt(77, 5)).toBe(true)
  })

  it('isWorthIt: coding <45 and price>0 → false', () => {
    expect(isWorthIt(30, 10)).toBe(false)
    expect(isWorthIt(null, 10)).toBe(false)
    expect(isWorthIt(44.9, 5)).toBe(false)
  })

  it('tierRank: frontier_coding outranks budget_free', () => {
    expect(tierRank('frontier_coding', 'budget_free')).toBeLessThan(0)
    expect(tierRank('budget_free', 'frontier_coding')).toBeGreaterThan(0)
    expect(tierRank('frontier_coding', 'frontier_coding')).toBe(0)
  })

  it('tierRank: fast_agent between frontier and budget', () => {
    expect(tierRank('frontier_coding', 'fast_agent')).toBeLessThan(0)
    expect(tierRank('fast_agent', 'budget_free')).toBeLessThan(0)
    expect(tierRank('vision_multimodal', 'fast_agent')).toBeLessThan(0)
  })

  it('tierRank single-arg returns numeric order', () => {
    expect(tierRank('frontier_coding')).toBe(0)
    expect(tierRank('budget_free')).toBe(3)
    expect(tierRank('unknown_tier')).toBe(99)
  })

  it('tierRank unknown tier is last', () => {
    expect(tierRank('frontier_coding', 'unknown')).toBeLessThan(0)
    expect(tierRank('unknown', 'budget_free')).toBeGreaterThan(0)
  })
})

describe('intelligence/scoring — rankCandidates', () => {
  it('sorts descending by valueScore via Map snapshot', () => {
    const snapshot = new Map<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    >([
      ['a', { codingIndex: 80, pricePer1MInput: 10, pricePer1MOutput: 10 }],
      ['b', { codingIndex: 50, pricePer1MInput: 1, pricePer1MOutput: 1 }],
      ['c', { codingIndex: 77, pricePer1MInput: 0, pricePer1MOutput: 0 }],
    ])
    // valueScores: a=4, b=25, c=1000 → order c,b,a
    const ordered = rankCandidates(
      ['a', 'b', 'c'],
      snapshot as unknown as Map<string, never>,
    )
    expect(ordered).toEqual(['c', 'b', 'a'])
  })

  it('supports Record snapshot shape', () => {
    const snapshot: Record<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    > = {
      a: { codingIndex: 90, pricePer1MInput: 5, pricePer1MOutput: 5 },
      b: { codingIndex: 40, pricePer1MInput: 2, pricePer1MOutput: 2 },
    }
    // a=9, b=10 → b first
    const ordered = rankCandidates(['a', 'b'], snapshot as unknown as never)
    expect(
      ordered.map((c) =>
        typeof c === 'string' ? c : (c as { id: string }).id,
      ),
    ).toEqual(['b', 'a'])
  })

  it('supports object candidates with model/id', () => {
    const snapshot = new Map<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    >([
      [
        'opencode/x-preview-f-free',
        { codingIndex: 77, pricePer1MInput: 0, pricePer1MOutput: 0 },
      ],
      [
        'opencode/muse-spark-1.2-contributor-free',
        { codingIndex: 50, pricePer1MInput: 10, pricePer1MOutput: 10 },
      ],
    ])
    const candidates = [
      { model: 'opencode/muse-spark-1.2-contributor-free' },
      { model: 'opencode/x-preview-f-free' },
    ]
    const ordered = rankCandidates(
      candidates as unknown as string[],
      snapshot as unknown as never,
    )
    expect((ordered[0] as { model: string }).model).toBe(
      'opencode/x-preview-f-free',
    )
  })

  it('fallback when snapshot null → static registry scoring (contextWindow)', () => {
    const candidates = [
      'opencode/x-preview-f-free', // 1_048_576
      'opencode/muse-spark-1.2-contributor-free', // 131_072
      'opencode/laguna-s-2.1-free', // 262_144
    ]
    const ordered = rankCandidates(candidates, null)
    // fallback: contextWindow/10_000 → 104.85, 13.10, 26.21 → order x-preview, laguna, muse-spark
    expect(ordered).toEqual([
      'opencode/x-preview-f-free',
      'opencode/laguna-s-2.1-free',
      'opencode/muse-spark-1.2-contributor-free',
    ])
    // also undefined snapshot behaves same
    const ordered2 = rankCandidates(candidates, undefined)
    expect(ordered2).toEqual(ordered)
  })

  it('does not mutate input array', () => {
    const snapshot = new Map<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    >([
      ['b', { codingIndex: 90, pricePer1MInput: 1, pricePer1MOutput: 1 }],
      ['a', { codingIndex: 10, pricePer1MInput: 1, pricePer1MOutput: 1 }],
    ])
    const input = ['a', 'b']
    const copy = [...input]
    const ordered = rankCandidates(input, snapshot as unknown as never)
    expect(input).toEqual(copy)
    expect(ordered).not.toBe(input)
    expect(ordered).toEqual(['b', 'a'])
  })

  it('handles valueScore already on candidate (priority)', () => {
    const candidates = [
      { model: 'a', valueScore: 1 },
      { model: 'b', valueScore: 99 },
      { model: 'c', valueScore: 50 },
    ]
    const ordered = rankCandidates(candidates as unknown as string[], null)
    expect((ordered as typeof candidates).map((c) => c.model)).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('stable tie-break by original index', () => {
    const snapshot = new Map<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    >([
      ['a', { codingIndex: 50, pricePer1MInput: 5, pricePer1MOutput: 5 }],
      ['b', { codingIndex: 50, pricePer1MInput: 5, pricePer1MOutput: 5 }],
      ['c', { codingIndex: 50, pricePer1MInput: 5, pricePer1MOutput: 5 }],
    ])
    const ordered = rankCandidates(
      ['a', 'b', 'c'],
      snapshot as unknown as never,
    )
    expect(ordered).toEqual(['a', 'b', 'c'])
  })

  it('handles empty and unknown models (unknown → 0 score last)', () => {
    expect(rankCandidates([], null)).toEqual([])
    const snapshot = new Map<
      string,
      { codingIndex: number; pricePer1MInput: number; pricePer1MOutput: number }
    >([['known', { codingIndex: 80, pricePer1MInput: 1, pricePer1MOutput: 1 }]])
    const ordered = rankCandidates(
      ['unknown-model', 'known'],
      snapshot as unknown as never,
    )
    expect(ordered[0]).toBe('known')
    expect(ordered[1]).toBe('unknown-model')
  })

  it('uses MODEL_REGISTRY for fallback and does not require snapshot entries for all', () => {
    const knownId = Object.keys(MODEL_REGISTRY)[0]!
    const unknown = 'not-in-registry-xyz'
    const ordered = rankCandidates([unknown, knownId], null)
    expect(ordered[0]).toBe(knownId)
  })
})
