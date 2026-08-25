import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'
import { clampBody, estimateInputTokens } from '../../src/normalizer/clamp.js'

/**
 * Helper to build a large messages array that yields exactly 219879 inputTokens
 * when passed through estimateInputTokens. The assignment suggests
 * `[{role:'user', content:'a'.repeat(219879*4)}]` (~879k chars -> ~219879 tokens).
 * JSON.stringify overhead is 32 chars (`[]` + `{"role":"user","content":""}` + `""` for tools),
 * so we subtract 32 to hit exactly 219879: `a`.repeat(219879*4 - 32) -> s.length 879516 -> 219879 tokens.
 * Then 262144 - 219879 - 256 = 42009 effective budget for laguna.
 */
function buildLagunaBigMessages(): unknown[] {
  return [{ role: 'user', content: 'a'.repeat(219879 * 4 - 32) }]
}

function buildHugeOverflowMessages(): unknown[] {
  // exceed laguna contextWindow (262144) -> tokens 300000 -> windowBudget negative -> floor to 1
  return [{ role: 'user', content: 'a'.repeat(300000 * 4 - 32) }]
}

function tinyMessages(): unknown[] {
  return [{ role: 'user', content: 'hi' }]
}

describe('estimateInputTokens', () => {
  it('empty messages and undefined tools -> 1', () => {
    expect(estimateInputTokens(undefined, undefined)).toBe(1)
    expect(estimateInputTokens(null, undefined)).toBe(1)
  })

  it('empty array messages -> 1', () => {
    expect(estimateInputTokens([], undefined)).toBe(1)
  })

  it('large message yields 219879', () => {
    const msgs = buildLagunaBigMessages()
    expect(estimateInputTokens(msgs, undefined)).toBe(219879)
  })

  it('tools contribute to count', () => {
    const msgs: unknown = [{ role: 'user', content: 'hi' }]
    const tools: unknown = [{ type: 'function', function: { name: 'x' } }]
    const without = estimateInputTokens(msgs, undefined)
    const withTools = estimateInputTokens(msgs, tools)
    expect(withTools).toBeGreaterThan(without)
  })
})

describe('clampBody - opencode/x-preview-f-free', () => {
  const spec = MODEL_REGISTRY['opencode/x-preview-f-free']!

  it('requested 1000 -> 1000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 1000,
    }
    const out = clampBody(body, spec)
    expect(out.max_tokens).toBe(1000)
  })

  it('requested 131072 -> 131072 (at cap)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 131072,
    }
    expect(clampBody(body, spec).max_tokens).toBe(131072)
  })

  it('requested 200000 -> 131072 (clamped to maxOutput)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(131072)
  })

  it('requested 0 -> 1 (floor to minOutput 1)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 0,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1)
  })

  it('requested undefined -> 131072 (defaults to maxOutput)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
    }
    const out = clampBody(body, spec)
    expect(out.max_tokens).toBe(131072)
  })

  it('max_completion_tokens 200000 -> 131072', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_completion_tokens: 200000,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(131072)
  })

  it('both max_tokens and max_completion_tokens present -> both clamped', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 50000,
      max_completion_tokens: 200000,
    }
    const out = clampBody(body, spec)
    expect(out.max_tokens).toBe(50000)
    expect(out.max_completion_tokens).toBe(131072)
  })

  it('neither present -> sets max_tokens to effective (131072)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
    }
    const out = clampBody(body, spec)
    expect(out.max_tokens).toBe(131072)
    expect(out.max_completion_tokens).toBeUndefined()
  })

  it('negative requested -> floor 1', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: -500,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1)
  })

  it('context overflow -> floor 1', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: buildHugeOverflowMessages(),
      max_tokens: 1000,
    }
    // For x-preview max 131072 but windowBudget huge negative? Actually x-preview window 1M, huge 300k not overflow.
    // Use laguna spec for overflow but also test x-preview with even huger
    const hugeForXPreview: unknown[] = [
      { role: 'user', content: 'a'.repeat(1_100_000 * 4 - 32) },
    ]
    const b: Record<string, unknown> = {
      model: spec.id,
      messages: hugeForXPreview,
      max_tokens: 1000,
    }
    expect(clampBody(b, spec).max_tokens).toBe(1)
  })

  it('purity: original not mutated', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
    }
    const before = JSON.stringify(body)
    const copy = clampBody(body, spec)
    expect(JSON.stringify(body)).toBe(before)
    expect(copy).not.toBe(body)
    expect(body.max_tokens).toBe(200000)
  })

  it('idempotence: twice same result', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
    }
    const first = clampBody(body, spec)
    const second = clampBody(first, spec)
    expect(second).toEqual(first)
    expect(second.max_tokens).toBe(131072)
  })
})

describe('clampBody - opencode/big-pickle', () => {
  const spec = MODEL_REGISTRY['opencode/big-pickle']!

  it('requested 1000 -> 1000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1000)
  })

  it('requested 200000 -> 131072', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(131072)
  })

  it('undefined -> 131072', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
    }
    expect(clampBody(body, spec).max_tokens).toBe(131072)
  })

  it('purity and idempotence', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 131072,
    }
    const before = JSON.stringify(body)
    const first = clampBody(body, spec)
    expect(JSON.stringify(body)).toBe(before)
    expect(clampBody(first, spec)).toEqual(first)
  })
})

describe('clampBody - opencode/laguna-s-2.1-free boundaries', () => {
  const spec = MODEL_REGISTRY['opencode/laguna-s-2.1-free']!

  it('384000 with inputTokens 219879 -> 42009 (window constrained)', () => {
    const msgs = buildLagunaBigMessages()
    expect(estimateInputTokens(msgs, undefined)).toBe(219879)
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 384000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(42009)
  })

  it('65536 with same large input -> 42009 (effective < maxOutput)', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 65536,
    }
    expect(clampBody(body, spec).max_tokens).toBe(42009)
  })

  it('1000 with large input -> 1000 (below effective)', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1000)
  })

  it('1000 with tiny input -> 1000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1000)
  })

  it('max_completion_tokens path with large input -> 42009', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_completion_tokens: 384000,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(42009)
  })

  it('context overflow negative -> floor 1', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: buildHugeOverflowMessages(),
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1)
  })

  it('purity check', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 384000,
    }
    const before = JSON.stringify(body)
    const out = clampBody(body, spec)
    expect(JSON.stringify(body)).toBe(before)
    expect(out).not.toBe(body)
  })

  it('idempotence', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 384000,
    }
    const first = clampBody(body, spec)
    const second = clampBody(first, spec)
    expect(second).toEqual(first)
    expect(second.max_tokens).toBe(42009)
  })
})

describe('clampBody - opencode/mimo-v2.5-free', () => {
  const spec = MODEL_REGISTRY['opencode/mimo-v2.5-free']!

  it('384000 with 219879 input -> 42009', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 384000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(42009)
  })

  it('65536 with large input -> 42009', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_tokens: 65536,
    }
    expect(clampBody(body, spec).max_tokens).toBe(42009)
  })

  it('1000 with tiny input -> 1000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1000)
  })

  it('max_completion_tokens also clamped', () => {
    const msgs = buildLagunaBigMessages()
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: msgs,
      max_completion_tokens: 65536,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(42009)
  })
})

describe('clampBody - opencode/muse-spark-1.2-contributor-free', () => {
  const spec = MODEL_REGISTRY['opencode/muse-spark-1.2-contributor-free']!

  it('50000 -> 32768 (maxOutput 32768)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 50000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(32768)
  })

  it('0 -> 512 (minOutput 512)', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 0,
    }
    expect(clampBody(body, spec).max_tokens).toBe(512)
  })

  it('negative -> 512', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: -100,
    }
    expect(clampBody(body, spec).max_tokens).toBe(512)
  })

  it('context overflow -> 512', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: buildHugeOverflowMessages(),
      max_tokens: 1000,
    }
    // For muse-spark window 131072, huge 300k tokens definitely overflow
    expect(clampBody(body, spec).max_tokens).toBe(512)
  })

  it('undefined -> 32768', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
    }
    expect(clampBody(body, spec).max_tokens).toBe(32768)
  })

  it('max_completion_tokens 50000 -> 32768', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_completion_tokens: 50000,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(32768)
  })
})

describe('clampBody - commandcode/deepseek/deepseek-v4-flash', () => {
  const spec = MODEL_REGISTRY['commandcode/deepseek/deepseek-v4-flash']!

  it('250000 -> 200000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 250000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(200000)
  })

  it('100000 -> 100000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 100000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(100000)
  })

  it('undefined -> 200000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
    }
    expect(clampBody(body, spec).max_tokens).toBe(200000)
  })

  it('max_completion_tokens 250000 -> 200000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_completion_tokens: 250000,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(200000)
  })
})

describe('clampBody - commandcode/gpt-5.6-luna', () => {
  const spec = MODEL_REGISTRY['commandcode/gpt-5.6-luna']!

  it('20000 -> 16384', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 20000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(16384)
  })

  it('1000 -> 1000', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 1000,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1000)
  })

  it('0 -> 1 floor', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 0,
    }
    expect(clampBody(body, spec).max_tokens).toBe(1)
  })

  it('max_completion_tokens 20000 -> 16384', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_completion_tokens: 20000,
    }
    expect(clampBody(body, spec).max_completion_tokens).toBe(16384)
  })
})

describe('clampBody - generic edge cases', () => {
  const spec = MODEL_REGISTRY['opencode/x-preview-f-free']!

  it('shallow copy does not mutate input object', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
      extra: 'keep',
    }
    const before = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
    const out = clampBody(body, spec)
    expect(body).toEqual(before)
    expect(out).not.toBe(body)
    expect(out.extra).toBe('keep')
    expect((out as Record<string, unknown>).max_tokens).toBe(131072)
  })

  it('handles tools in token estimation', () => {
    const tools: unknown = [
      {
        type: 'function',
        function: { name: 'search', description: 'a'.repeat(1000) },
      },
    ]
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      tools,
      max_tokens: 131072,
    }
    const out = clampBody(body, spec)
    // still clamped to maxOutput because small input
    expect(out.max_tokens).toBe(131072)
    expect(estimateInputTokens(tinyMessages(), tools)).toBeGreaterThan(
      estimateInputTokens(tinyMessages(), undefined),
    )
  })

  it('idempotence across max_completion_tokens', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_completion_tokens: 200000,
    }
    const first = clampBody(body, spec)
    const second = clampBody(first, spec)
    expect(second).toEqual(first)
  })

  it('both present idempotence', () => {
    const body: Record<string, unknown> = {
      model: spec.id,
      messages: tinyMessages(),
      max_tokens: 200000,
      max_completion_tokens: 200000,
    }
    const first = clampBody(body, spec)
    const second = clampBody(first, spec)
    expect(second).toEqual(first)
    expect(first.max_tokens).toBe(131072)
    expect(first.max_completion_tokens).toBe(131072)
  })
})
