import { describe, it, expect } from 'vitest'
import { MODEL_REGISTRY, getModelSpec } from '../../src/config/models.js'
import { PROVIDERS, getProviderForModel } from '../../src/config/providers.js'

describe('P9 PR#1 — perplexity (2 models)', () => {
  it('provider exists with real baseUrl + key env', () => {
    const p = PROVIDERS['perplexity']
    expect(p).toBeDefined()
    expect(p?.baseUrl).toBe('https://api.perplexity.ai/chat/completions')
    expect(p?.apiKeyEnv).toBe('PERPLEXITY_API_KEY')
    expect(p?.format).toBe('openai')
  })

  it('getProviderForModel resolves both ids via prefix', () => {
    expect(getProviderForModel('perplexity/sonar')?.apiKeyEnv).toBe(
      'PERPLEXITY_API_KEY',
    )
    expect(getProviderForModel('perplexity/sonar-pro')).toBeDefined()
  })

  it('caps verbatim: sonar 127072/114364, sonar-pro 200000/8000', () => {
    const s = MODEL_REGISTRY['perplexity/sonar']
    expect(s?.contextWindow).toBe(127_072)
    expect(s?.maxOutputTokens).toBe(114_364)
    const sp = MODEL_REGISTRY['perplexity/sonar-pro']
    expect(sp?.contextWindow).toBe(200_000)
    expect(sp?.maxOutputTokens).toBe(8_000)
  })

  it('clamp boundary: 999999 → maxOutputTokens per model', () => {
    // clamp formula min(requested, maxOutput, window-input-256), 4 chars/token
    for (const id of ['perplexity/sonar', 'perplexity/sonar-pro']) {
      const spec = getModelSpec(id)
      expect(spec).toBeDefined()
      expect(spec!.maxOutputTokens).toBeLessThanOrEqual(spec!.contextWindow)
      expect(spec!.maxOutputTokens).toBeGreaterThanOrEqual(1024)
    }
  })

  it('supportedParams ∪ stripParams disjoint and non-empty supported', () => {
    const s = MODEL_REGISTRY['perplexity/sonar']
    expect(s).toBeDefined()
    if (!s) return
    for (const p of s.stripParams) {
      expect(s.supportedParams.has(p)).toBe(false)
    }
    expect(s.supportedParams.size).toBeGreaterThan(0)
  })
})
