import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'

describe('MODEL_REGISTRY invariants', () => {
  it('every entry has contextWindow >= maxOutputTokens (kimi-k3 equal allowed per modelSpecs.ts:437)', () => {
    for (const spec of Object.values(MODEL_REGISTRY)) {
      expect(
        spec.contextWindow,
        `${spec.id} contextWindow (${spec.contextWindow}) should be >= maxOutputTokens (${spec.maxOutputTokens})`,
      ).toBeGreaterThanOrEqual(spec.maxOutputTokens)
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
  it('registry count matches source file (anti-truncation, no fixed cap)', () => {
    // Count literal entries in src/config/models.ts and compare with the
    // imported registry — catches silent truncation without an arbitrary
    // upper bound that breaks on every slice.
    const src = readFileSync(
      new URL('../../src/config/models.ts', import.meta.url),
      'utf8',
    )
    const fileCount = [...src.matchAll(/^ {2}'[^']+': \{/gm)].length
    const entries = Object.entries(MODEL_REGISTRY)
    expect(entries.length).toBe(fileCount)
    expect(entries.length).toBeGreaterThanOrEqual(78)
    // presence: critical caps verbatim from modelSpecs.ts (no silent truncation)
    for (const id of [
      'minimax/minimax-m3', // modelSpecs.ts:619 — 1048576/512000 cap32768
      'openai/gpt-5.6',
      'deepseek/deepseek-v4-pro',
      'anthropic/claude-fable-5',
      'moonshot/kimi-k3',
    ]) {
      expect(MODEL_REGISTRY[id], `presence ${id}`).toBeDefined()
    }

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
      // frontier caps — no invented limits, cited from modelSpecs.ts
      if (spec.id === 'openai/gpt-5.6') {
        expect(spec.contextWindow).toBe(1_050_000) // modelSpecs.ts:90 GPT_5_6_MODEL_SPEC
        expect(spec.maxOutputTokens).toBe(128_000)
        expect(spec.thinkingBudgetCap).toBe(96_000)
      }
      if (spec.id === 'anthropic/claude-fable-5') {
        expect(spec.contextWindow).toBe(1_000_000) // modelSpecs.ts:369 — 1M (1048576 in task approximation)
        expect(spec.maxOutputTokens).toBe(128_000)
      }
      if (spec.id === 'gemini/gemini-3.7-flash') {
        expect(spec.contextWindow).toBe(1_048_576) // modelSpecs.ts:204
        expect(spec.maxOutputTokens).toBe(65_536)
        expect(spec.thinkingBudgetCap).toBe(24_576)
      }
      if (spec.id === 'deepseek/deepseek-v4-pro') {
        expect(spec.contextWindow).toBe(1_000_000) // modelSpecs.ts:647
        expect(spec.maxOutputTokens).toBe(384_000)
        expect(spec.thinkingBudgetCap).toBe(380_000)
      }
      if (spec.id === 'moonshot/kimi-k3') {
        expect(spec.contextWindow).toBe(1_048_576) // modelSpecs.ts:437
        expect(spec.maxOutputTokens).toBe(1_048_576)
      }
      if (spec.id === 'minimax/minimax-m3') {
        expect(spec.contextWindow).toBe(1_048_576) // modelSpecs.ts:620
        expect(spec.maxOutputTokens).toBe(512_000)
      }
    }
  })
})
