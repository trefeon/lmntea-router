import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'
import { reconcileThinking } from '../../src/normalizer/thinking.js'

describe('reconcileThinking', () => {
  const spec = MODEL_REGISTRY['opencode/laguna-s-2.1-free']!
  const deepseek = MODEL_REGISTRY['commandcode/deepseek/deepseek-v4-flash']!

  it('budget 8192 with max_tokens 4096 -> 9216', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      thinking: { budget_tokens: 8192 },
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(9216)
    expect(result).not.toBe(body)
  })

  it('budget 8192 with max_tokens 10000 -> 10000 (no shrink)', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 10000,
      thinking: { budget_tokens: 8192 },
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(10000)
  })

  it('budget 0 disabled -> no-op max unchanged', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      thinking: { budget_tokens: 0 },
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(4096)
    // should remain 4096, not 1024
    expect(result.max_tokens).not.toBe(1024)
  })

  it('reasoning_effort high -> 32768 then reconcile to 33792', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      reasoning_effort: 'high',
    }
    const result = reconcileThinking(body, spec)
    // 32768+1024=33792 >4096
    expect(result.max_tokens).toBe(33792)
    const thinking = result.thinking as { budget_tokens: number }
    expect(thinking.budget_tokens).toBe(32768)
  })

  it('reasoning_effort low -> 1024 then reconcile to 2048', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 1000,
      reasoning_effort: 'low',
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(2048)
    const thinking = result.thinking as { budget_tokens: number }
    expect(thinking.budget_tokens).toBe(1024)
  })

  it('reasoning_effort medium -> 8192 then reconcile to 9216', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 2000,
      reasoning_effort: 'medium',
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(9216)
  })

  it('idempotence: calling twice yields same result', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      thinking: { budget_tokens: 8192 },
    }
    const first = reconcileThinking(body, spec)
    const second = reconcileThinking(first, spec)
    expect(second).toEqual(first)
    expect(second.max_tokens).toBe(9216)
    // also test reasoning_effort idempotence
    const body2 = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      reasoning_effort: 'high',
    }
    const f1 = reconcileThinking(body2, spec)
    const f2 = reconcileThinking(f1, spec)
    expect(f2).toEqual(f1)
    expect(f2.max_tokens).toBe(33792)
  })

  it('requiresThinkingReconciliation false but budget still reconciles', () => {
    // all registry specs currently have false, verify still reconciles
    expect(spec.requiresThinkingReconciliation).toBe(false)
    expect(deepseek.requiresThinkingReconciliation).toBe(false)
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 1000,
      thinking: { budget_tokens: 5000 },
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(6024) // 5000+1024
    const result2 = reconcileThinking(body, deepseek)
    expect(result2.max_tokens).toBe(6024)
  })

  it('does not mutate input', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      thinking: { budget_tokens: 8192 },
    }
    const original = JSON.parse(JSON.stringify(body))
    const result = reconcileThinking(body, spec)
    expect(body).toEqual(original)
    expect(result).not.toBe(body)
    expect(result.max_tokens).toBe(9216)
    // input max_tokens unchanged
    expect(body.max_tokens).toBe(4096)
  })

  it('reasoning_effort none -> 0 -> no-op', () => {
    const body = {
      model: spec.id,
      messages: [],
      max_tokens: 4096,
      reasoning_effort: 'none',
    }
    const result = reconcileThinking(body, spec)
    expect(result.max_tokens).toBe(4096)
  })

  it('falls back to spec.maxOutputTokens when max_tokens undefined', () => {
    const smallSpec =
      MODEL_REGISTRY['opencode/muse-spark-1.2-contributor-free']! // max 32768
    const body = {
      model: smallSpec.id,
      messages: [],
      thinking: { budget_tokens: 8192 },
    }
    const result = reconcileThinking(body, smallSpec)
    // spec.maxOutputTokens 32768 >9216 so stays 32768
    expect(result.max_tokens).toBe(32768)
    // with large budget that exceeds spec max
    const body2 = {
      model: smallSpec.id,
      messages: [],
      thinking: { budget_tokens: 40000 },
    }
    const result2 = reconcileThinking(body2, smallSpec)
    expect(result2.max_tokens).toBe(41024) // 40000+1024 >32768
  })
})
