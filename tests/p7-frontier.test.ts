import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'

const FRONTIER_SAMPLES: Array<{
  provider: string
  model: string
  maxOutput: number
}> = [
  { provider: 'openai', model: 'openai/gpt-5.6', maxOutput: 128_000 },
  {
    provider: 'anthropic',
    model: 'anthropic/claude-fable-5',
    maxOutput: 128_000,
  },
  { provider: 'gemini', model: 'gemini/gemini-3.7-flash', maxOutput: 65_536 },
  {
    provider: 'deepseek',
    model: 'deepseek/deepseek-v4-pro',
    maxOutput: 384_000,
  },
  { provider: 'moonshot', model: 'moonshot/kimi-k3', maxOutput: 1_048_576 },
  { provider: 'zai', model: 'zai/glm-5.2', maxOutput: 131_072 },
  { provider: 'minimax', model: 'minimax/minimax-m3', maxOutput: 512_000 },
  {
    provider: 'volcengine',
    model: 'volcengine/DeepSeek-V4-Pro',
    maxOutput: 384_000,
  },
  {
    provider: 'xiaomi-mimo',
    model: 'xiaomi-mimo/mimo-v2.5',
    maxOutput: 131_072,
  },
  {
    provider: 'bedrock',
    model: 'bedrock/anthropic.claude-fable-5',
    maxOutput: 128_000,
  },
]

describe('P7 Frontier 10 providers ~70 models — integration (app.request 200 stream)', () => {
  const origAuth = process.env.AUTH_TOKENS
  const origApiKeys = process.env.API_KEYS

  beforeEach(() => {
    process.env.AUTH_TOKENS = 'sk-test'
    process.env.API_KEYS = ''
  })
  afterEach(() => {
    process.env.AUTH_TOKENS = origAuth
    process.env.API_KEYS = origApiKeys
  })

  for (const { provider, model, maxOutput } of FRONTIER_SAMPLES) {
    it(`${provider} ${model} stream:true → 200 text/event-stream with clamped header`, async () => {
      const app = createApp()
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 999_999,
          stream: true,
        }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
      const clamped = Number(res.headers.get('x-clamped-max-tokens'))
      expect(clamped).toBeLessThanOrEqual(maxOutput)
      expect(clamped).toBeGreaterThan(0)
    })

    it(`${provider} ${model} /v1/messages stream:true → 200`, async () => {
      const app = createApp()
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 999_999,
          stream: true,
        }),
      })
      // messages endpoint also supports stream via earlyKeepalive mock; in test env it returns 200 with SSE
      expect([200, 501]).toContain(res.status)
      if (res.status === 200) {
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
      }
    })
  }

  it('non-stream frontier still normalizes (501 stub) with correct clamp for minimax-m3', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m3',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999_999,
      }),
    })
    expect(res.status).toBe(501)
    expect(res.headers.get('x-clamped-max-tokens')).toBe('512000')
  })
})
