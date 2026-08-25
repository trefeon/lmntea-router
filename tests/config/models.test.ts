import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'

describe('MODEL_REGISTRY invariants', () => {
  it('every entry has contextWindow > maxOutputTokens', () => {
    for (const spec of Object.values(MODEL_REGISTRY)) {
      expect(
        spec.contextWindow,
        `${spec.id} contextWindow (${spec.contextWindow}) should be > maxOutputTokens (${spec.maxOutputTokens})`,
      ).toBeGreaterThan(spec.maxOutputTokens)
    }
  })

  it('every entry has maxOutputTokens >= 1024', () => {
    for (const spec of Object.values(MODEL_REGISTRY)) {
      expect(
        spec.maxOutputTokens,
        `${spec.id} maxOutputTokens should be >= 1024`,
      ).toBeGreaterThanOrEqual(1024)
    }
  })

  it('has no duplicate id (Set size === Object.keys size)', () => {
    const ids = Object.values(MODEL_REGISTRY).map((s) => s.id)
    const keys = Object.keys(MODEL_REGISTRY)
    expect(new Set(ids).size).toBe(keys.length)
    expect(new Set(keys).size).toBe(keys.length)
    // each key should equal its spec id
    for (const [key, spec] of Object.entries(MODEL_REGISTRY)) {
      expect(spec.id).toBe(key)
    }
  })

  it('has 8 entries and respects normative caps (opencode <=131072, commandcode <=200000)', () => {
    const entries = Object.entries(MODEL_REGISTRY)
    expect(entries.length).toBe(8)

    for (const [, spec] of entries) {
      if (spec.provider === 'opencode') {
        expect(
          spec.maxOutputTokens,
          `${spec.id} opencode maxOutputTokens should be <= 131072`,
        ).toBeLessThanOrEqual(131_072)
      }
      if (spec.provider === 'commandcode') {
        expect(
          spec.maxOutputTokens,
          `${spec.id} commandcode maxOutputTokens should be <= 200000`,
        ).toBeLessThanOrEqual(200_000)
      }
    }
  })
})
