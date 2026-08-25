import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetIntelligenceStateForTests,
  getSyncedSnapshot,
  startIntelligenceSync,
  syncOnce,
} from '../../src/intelligence/sync.js'
import * as syncModule from '../../src/intelligence/sync.js'

// helpers — minimal valid OR + AA payloads
function orModel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'opencode/x-preview-f-free',
    canonical_slug: 'opencode/x-preview-f-free',
    name: 'X Preview',
    created: 1_700_000_000,
    description: 'Test model',
    context_length: 262_144,
    architecture: {
      modality: 'text->text',
      input_modalities: ['text'] as const,
      output_modalities: ['text'] as const,
      tokenizer: 'Test',
      instruct_type: null,
    },
    top_provider: {
      context_length: 262_144,
      max_completion_tokens: 65_536,
      is_moderated: false,
    },
    supported_parameters: ['tools', 'temperature'],
    pricing: {
      prompt: '0.000001',
      completion: '0.000002',
    },
    reasoning: { supported_efforts: ['low', 'high'] as const },
    ...overrides,
  }
}

function orModel2() {
  return orModel({
    id: 'commandcode/deepseek/deepseek-v4-flash',
    canonical_slug: 'commandcode/deepseek/deepseek-v4-flash',
    name: 'DeepSeek Flash',
    context_length: 128_000,
    top_provider: {
      context_length: 128_000,
      max_completion_tokens: 16_384,
      is_moderated: false,
    },
    pricing: { prompt: '0.0000005', completion: '0.000001' },
    supported_parameters: ['tools'],
    architecture: {
      modality: 'text->text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'DeepSeek',
      instruct_type: null,
    },
  })
}

function aaModel(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'opencode/x-preview-f-free',
    name: 'X Preview',
    evaluations: {
      artificial_analysis_intelligence_index: 62.5,
      artificial_analysis_coding_index: 77,
      artificial_analysis_agentic_index: 68,
    },
    performance: {
      median_output_tokens_per_second: 87.5,
      median_time_to_first_token_seconds: 1.86,
    },
    ...overrides,
  }
}

// mock Response factory
function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('intelligence/sync — advisory background sync', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    __resetIntelligenceStateForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // default: provide AA key so both feeds are attempted unless test overrides
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'test-aa-key'
    process.env.OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models'
    process.env.ARTIFICIAL_ANALYSIS_API_URL =
      'https://artificialanalysis.ai/api/v2/data/llms/models'
    // silence warnings in tests
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v as string
    }
    __resetIntelligenceStateForTests()
  })

  it('success merge: both feeds ok → N merged with AA fields and pricing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({ data: [orModel(), orModel2()] })
      }
      if (u.includes('artificialanalysis')) {
        return jsonResponse({ data: [aaModel()] })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const map = await syncOnce()
    expect(map.size).toBeGreaterThanOrEqual(2)
    // OR ids present
    expect(map.has('opencode/x-preview-f-free')).toBe(true)
    expect(map.has('commandcode/deepseek/deepseek-v4-flash')).toBe(true)
    // merged AA fields for first model
    const synced = map.get('opencode/x-preview-f-free')!
    expect(synced.pricePer1MInput).toBeCloseTo(1)
    expect(synced.pricePer1MOutput).toBeCloseTo(2)
    expect(synced.intelligenceIndex).toBe(62.5)
    expect(synced.codingIndex).toBe(77)
    expect(synced.outputTokensPerSecond).toBe(87.5)
    expect(synced.timeToFirstTokenSec).toBe(1.86)
    expect(synced.contextLength).toBe(262_144)
    expect(synced.maxCompletionTokens).toBe(65_536)
    // second model without AA should have null intelligence
    const second = map.get('commandcode/deepseek/deepseek-v4-flash')!
    expect(second.intelligenceIndex).toBeNull()
    // snapshot + lastSyncAt populated
    const snap = getSyncedSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.size).toBe(map.size)
    expect(typeof syncModule.lastSyncAt).toBe('number')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('401 fallback: AA 401 → still merges OpenRouter alone', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({ data: [orModel()] })
      }
      if (u.includes('artificialanalysis')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const map = await syncOnce()
    expect(map.size).toBeGreaterThanOrEqual(1)
    expect(map.has('opencode/x-preview-f-free')).toBe(true)
    const entry = map.get('opencode/x-preview-f-free')!
    expect(entry.intelligenceIndex).toBeNull()
    expect(entry.codingIndex).toBeNull()
    expect(getSyncedSnapshot()).not.toBeNull()
  })

  it('no env fallback: without ARTIFICIAL_ANALYSIS_API_KEY, AA fetch is skipped and OR alone succeeds', async () => {
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY
    delete process.env.AA_API_KEY

    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({ data: [orModel()] })
      }
      // should not be called for AA
      if (u.includes('artificialanalysis')) {
        throw new Error('AA should not be fetched without key')
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const map = await syncOnce()
    expect(map.size).toBeGreaterThanOrEqual(1)
    expect(map.has('opencode/x-preview-f-free')).toBe(true)
    // verify AA was not fetched
    const aaCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('artificialanalysis'),
    )
    expect(aaCalls.length).toBe(0)
    expect(getSyncedSnapshot()).not.toBeNull()
  })

  it('fetch timeout: AbortError is advisory and does not throw (falls back to OR alone or empty)', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError')
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({ data: [orModel()] })
      }
      if (u.includes('artificialanalysis')) {
        throw abortErr
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await expect(syncOnce()).resolves.toBeInstanceOf(Map)
    const snap = getSyncedSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.has('opencode/x-preview-f-free')).toBe(true)
  })

  it('never throws: even if both feeds throw, syncOnce resolves with empty or last snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    )

    await expect(syncOnce()).resolves.toBeDefined()
    // should not throw even on second call
    await expect(syncOnce()).resolves.toBeDefined()
    // snapshot may be empty map on cold start, but not null after attempt? Our impl returns empty map
    const snap = getSyncedSnapshot()
    expect(snap).not.toBeNull()
    expect(snap instanceof Map).toBe(true)
  })

  it('never throws: OpenRouter 500 still does not throw and keeps advisory behavior', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return new Response('server error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      }
      if (u.includes('artificialanalysis')) {
        return jsonResponse({ data: [aaModel()] })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await expect(syncOnce()).resolves.toBeInstanceOf(Map)
    // with OR 500, map will be empty (no OR models) — advisory, not throw
    const snap = getSyncedSnapshot()
    expect(snap).not.toBeNull()
  })

  it('interval not required: startIntelligenceSync without opts does not throw and returns stop handle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('openrouter')) return jsonResponse({ data: [orModel()] })
        return new Response('not found', { status: 404 })
      }) as unknown as typeof fetch,
    )
    // delete AA key to avoid second fetch
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY
    delete process.env.AA_API_KEY

    expect(() => startIntelligenceSync()).not.toThrow()
    const handle = startIntelligenceSync()
    expect(handle).toBeDefined()
    expect(typeof handle.stop).toBe('function')
    handle.stop()

    // also with explicit interval
    const handle2 = startIntelligenceSync({ intervalMs: 60_000 })
    expect(typeof handle2.stop).toBe('function')
    handle2.stop()

    // calling with 6h default should still have scheduled (unref) — not throw
    const handle3 = startIntelligenceSync({ intervalMs: 6 * 60 * 60 * 1000 })
    handle3.stop()
  })

  it('getSyncedSnapshot is null before first sync and Map after', async () => {
    __resetIntelligenceStateForTests()
    expect(getSyncedSnapshot()).toBeNull()
    expect(syncModule.lastSyncAt).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('openrouter')) return jsonResponse({ data: [orModel()] })
        return new Response('not found', { status: 404 })
      }) as unknown as typeof fetch,
    )
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY
    delete process.env.AA_API_KEY

    await syncOnce()
    expect(getSyncedSnapshot()).not.toBeNull()
    expect(syncModule.lastSyncAt).not.toBeNull()
    expect(typeof syncModule.lastSyncAt).toBe('number')
  })

  it('SSRF guard: private hostname in env URL is treated as advisory failure, never throws', async () => {
    process.env.OPENROUTER_API_URL = 'http://127.0.0.1:9999/models'
    // AA key present but its URL remains public — OR will be blocked
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // should not even be called for OR because SSRF blocks before fetch
        const u = String(url)
        if (u.includes('127.0.0.1'))
          throw new Error('should have been blocked before fetch')
        if (u.includes('artificialanalysis'))
          return jsonResponse({ data: [aaModel()] })
        return new Response('not found', { status: 404 })
      }) as unknown as typeof fetch,
    )

    await expect(syncOnce()).resolves.toBeInstanceOf(Map)
    // snapshot may be empty because OR blocked
    expect(getSyncedSnapshot()).not.toBeNull()
  })

  it('hermetic: uses vi.stubGlobal(fetch) not real network, and respects OPENROUTER_API_KEY header when set', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test123'
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'aa-test'
    let capturedAuth: string | null = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        const h = new Headers(init?.headers as HeadersInit)
        capturedAuth = h.get('authorization')
        return jsonResponse({ data: [orModel()] })
      }
      if (u.includes('artificialanalysis')) {
        return jsonResponse({ data: [aaModel()] })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await syncOnce()
    expect(capturedAuth).toBe('Bearer sk-or-test123')
    delete process.env.OPENROUTER_API_KEY
  })
})
