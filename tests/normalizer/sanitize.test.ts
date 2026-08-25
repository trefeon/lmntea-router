import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'
import type { ModelSpec } from '../../src/config/models.js'
import { sanitizeParams } from '../../src/normalizer/sanitize.js'

describe('sanitizeParams', () => {
  const deepseek = MODEL_REGISTRY['commandcode/deepseek/deepseek-v4-flash']!
  const laguna = MODEL_REGISTRY['opencode/laguna-s-2.1-free']!

  it('deepseek strips temperature and top_p', () => {
    const body = {
      model: 'commandcode/deepseek/deepseek-v4-flash',
      messages: [],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1000,
    }
    const result = sanitizeParams(body, deepseek)
    expect(result).not.toHaveProperty('temperature')
    expect(result).not.toHaveProperty('top_p')
    expect(result).toHaveProperty('model')
    expect(result).toHaveProperty('max_tokens', 1000)
  })

  it('laguna preserves temperature and top_p when stripParams empty', () => {
    const body = {
      model: 'opencode/laguna-s-2.1-free',
      messages: [],
      temperature: 0.8,
      top_p: 0.95,
    }
    const result = sanitizeParams(body, laguna)
    expect(result).toHaveProperty('temperature', 0.8)
    expect(result).toHaveProperty('top_p', 0.95)
  })

  it('strips unknown param logprobs when supportedParams non-empty', () => {
    const custom: ModelSpec = {
      id: 'custom',
      provider: 'test',
      contextWindow: 8000,
      maxOutputTokens: 4000,
      supportedParams: new Set(['model', 'messages']),
      stripParams: new Set<string>(),
      requiresThinkingReconciliation: false,
    }
    const body = {
      model: 'custom',
      messages: [],
      logprobs: true,
      temperature: 0.5,
    }
    const result = sanitizeParams(body, custom)
    expect(result).not.toHaveProperty('logprobs')
    // temperature is in BASE_ALLOWLIST so it survives even when not in supportedParams
    expect(result).toHaveProperty('temperature', 0.5)
    expect(result).toHaveProperty('model', 'custom')
    expect(result).toHaveProperty('messages')
  })

  it('supportedParams empty means only strip list matters (logprobs preserved)', () => {
    const body = {
      model: 'opencode/laguna-s-2.1-free',
      messages: [],
      logprobs: true,
      temperature: 0.5,
    }
    const result = sanitizeParams(body, laguna)
    // laguna has empty supportedParams, so logprobs should NOT be stripped
    expect(result).toHaveProperty('logprobs', true)
    expect(result).toHaveProperty('temperature', 0.5)
  })

  it('deletes keys not in supportedParams and not in base allowlist', () => {
    const custom: ModelSpec = {
      id: 'custom2',
      provider: 'test',
      contextWindow: 8000,
      maxOutputTokens: 4000,
      supportedParams: new Set(['model', 'messages']),
      stripParams: new Set<string>(),
      requiresThinkingReconciliation: false,
    }
    const body = {
      model: 'custom2',
      messages: [],
      custom_unknown: 'value',
      presence_penalty: 0.1,
    }
    const result = sanitizeParams(body, custom)
    expect(result).not.toHaveProperty('custom_unknown')
    expect(result).toHaveProperty('presence_penalty', 0.1)
    expect(result).toHaveProperty('model')
  })

  it('does not mutate input and returns new object', () => {
    const body: Record<string, unknown> = {
      model: 'commandcode/deepseek/deepseek-v4-flash',
      messages: [],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 500,
    }
    const original = { ...body }
    const result = sanitizeParams(body, deepseek)
    // input not mutated
    expect(body).toEqual(original)
    expect(body).toHaveProperty('temperature', 0.7)
    expect(body).toHaveProperty('top_p', 0.9)
    // copy !== input
    expect(result).not.toBe(body)
    // deepEqual after removing stripped keys
    const expected = { ...original }
    delete (expected as Record<string, unknown>).temperature
    delete (expected as Record<string, unknown>).top_p
    expect(result).toEqual(expected)
  })

  it('handles stripParams combined with supportedParams filtering', () => {
    const custom: ModelSpec = {
      id: 'custom3',
      provider: 'test',
      contextWindow: 8000,
      maxOutputTokens: 4000,
      supportedParams: new Set(['model', 'messages', 'temperature']),
      stripParams: new Set(['temperature']),
      requiresThinkingReconciliation: false,
    }
    const body = {
      model: 'custom3',
      messages: [],
      temperature: 0.9,
      logprobs: true,
    }
    const result = sanitizeParams(body, custom)
    // stripParams takes precedence — temperature removed even though in supportedParams
    expect(result).not.toHaveProperty('temperature')
    expect(result).not.toHaveProperty('logprobs')
    expect(result).toHaveProperty('model')
  })
})
