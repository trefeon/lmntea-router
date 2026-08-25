import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_REGISTRY } from '../../src/config/models.js'
import { createApp } from '../../src/index.js'
import {
  __resetIntelligenceStateForTests,
  syncOnce,
} from '../../src/intelligence/sync.js'

const VALID = 'sk-test-models'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function orModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'opencode/x-preview-f-free',
    canonical_slug: 'opencode/x-preview-f-free',
    name: 'X Preview',
    created: 1_700_000_000,
    description: 'Test',
    context_length: 1_048_576,
    architecture: {
      modality: 'text->text',
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Test',
      instruct_type: null,
    },
    top_provider: {
      context_length: 1_048_576,
      max_completion_tokens: 131_072,
      is_moderated: false,
    },
    supported_parameters: ['tools', 'temperature'],
    pricing: { prompt: '0', completion: '0' },
    reasoning: { supported_efforts: ['low', 'high'] },
    ...overrides,
  }
}

function aaModel(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'opencode/x-preview-f-free',
    evaluations: {
      artificial_analysis_intelligence_index: 62.5,
      artificial_analysis_coding_index: 77,
    },
    performance: {
      median_output_tokens_per_second: 87.5,
      median_time_to_first_token_seconds: 1.86,
    },
    ...overrides,
  }
}

describe('GET /v1/models — enrichment (P6)', () => {
  const origAuth = process.env.AUTH_TOKENS
  const origAA = process.env.ARTIFICIAL_ANALYSIS_API_KEY
  const origOR = process.env.OPENROUTER_API_URL
  const origAAUrl = process.env.ARTIFICIAL_ANALYSIS_API_URL

  beforeEach(() => {
    process.env.AUTH_TOKENS = VALID
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'test-aa-key'
    process.env.OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models'
    process.env.ARTIFICIAL_ANALYSIS_API_URL =
      'https://artificialanalysis.ai/api/v2/data/llms/models'
    __resetIntelligenceStateForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.AUTH_TOKENS = origAuth
    if (origAA === undefined) delete process.env.ARTIFICIAL_ANALYSIS_API_KEY
    else process.env.ARTIFICIAL_ANALYSIS_API_KEY = origAA
    if (origOR === undefined) delete process.env.OPENROUTER_API_URL
    else process.env.OPENROUTER_API_URL = origOR
    if (origAAUrl === undefined) delete process.env.ARTIFICIAL_ANALYSIS_API_URL
    else process.env.ARTIFICIAL_ANALYSIS_API_URL = origAAUrl
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    __resetIntelligenceStateForTests()
  })

  it('GET /v1/models → 200 list with enriched shape (fallback when no sync)', async () => {
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as {
      object: string
      data: Array<Record<string, unknown>>
    }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
    // at least the registry size (8) and must contain the two legacy ids
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    const ids = body.data.map((m) => m.id as string)
    expect(ids).toContain('opencode/x-preview-f-free')
    expect(ids).toContain('opencode/muse-spark-1.2-contributor-free')
    // each entry keeps OpenAI compat fields + enriched fallbacks
    for (const m of body.data) {
      expect(m).toHaveProperty('id')
      expect(m).toHaveProperty('object', 'model')
      expect(m).toHaveProperty('created')
      expect(m).toHaveProperty('owned_by')
      expect(m).toHaveProperty('context_length')
      expect(m).toHaveProperty('max_completion_tokens')
      expect(m).toHaveProperty('valueScore')
      expect(m).toHaveProperty('tier')
    }
    // spot check a known registry entry fallback scoring
    const xprev = body.data.find((m) => m.id === 'opencode/x-preview-f-free')
    expect(xprev).toBeDefined()
    expect(typeof xprev!.valueScore).toBe('number')
    expect(xprev!.tier).toBe('budget_free')
  })

  it('GET /v1/models?provider=opencode filters correctly', async () => {
    const app = createApp()
    const res = await app.request('/v1/models?provider=opencode', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.length).toBeGreaterThan(0)
    for (const m of body.data) {
      expect(m.id.startsWith('opencode/')).toBe(true)
    }
    // provider=commandcode should give only commandcode models
    const res2 = await app.request('/v1/models?provider=commandcode', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    const body2 = (await res2.json()) as { data: Array<{ id: string }> }
    expect(body2.data.length).toBeGreaterThan(0)
    for (const m of body2.data)
      expect(m.id.startsWith('commandcode/')).toBe(true)
  })

  it('GET /v1/models/:id encoded slash → 200 enriched', async () => {
    const app = createApp()
    const id = 'opencode/x-preview-f-free'
    const encoded = encodeURIComponent(id)
    const res = await app.request(`/v1/models/${encoded}`, {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(id)
    expect(body.object).toBe('model')
    expect(body).toHaveProperty('context_length')
    expect(body).toHaveProperty('valueScore')
    expect(body).toHaveProperty('tier')
  })

  it('GET /v1/models/:id literal slash → 200 (wildcard route)', async () => {
    const app = createApp()
    const id = 'opencode/x-preview-f-free'
    const res = await app.request(`/v1/models/${id}`, {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(id)
  })

  it('GET /v1/models/:id deep slash (commandcode/deepseek/...) → 200', async () => {
    const app = createApp()
    const id = 'commandcode/deepseek/deepseek-v4-flash'
    const res = await app.request(`/v1/models/${id}`, {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(id)
    expect(body.owned_by).toBe('commandcode')
  })

  it('GET /v1/models/:id unknown → 404', async () => {
    const app = createApp()
    const res = await app.request('/v1/models/unknown%2Fmodel-xyz', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MODEL_NOT_FOUND')
  })

  it('merges static registry + synced snapshot (adds pricing, quality, valueScore, tier, lastSyncedAt)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({
          data: [
            orModel({
              id: 'opencode/x-preview-f-free',
              canonical_slug: 'opencode/x-preview-f-free',
              pricing: { prompt: '0', completion: '0' },
              context_length: 1_048_576,
              top_provider: {
                context_length: 1_048_576,
                max_completion_tokens: 131_072,
                is_moderated: false,
              },
            }),
            orModel({
              id: 'opencode/big-pickle',
              canonical_slug: 'opencode/big-pickle',
              pricing: { prompt: '0.000001', completion: '0.000002' },
              context_length: 262_144,
              top_provider: {
                context_length: 262_144,
                max_completion_tokens: 65_536,
                is_moderated: false,
              },
            }),
          ],
        })
      }
      if (u.includes('artificialanalysis')) {
        return jsonResponse({
          data: [
            aaModel({
              slug: 'opencode/x-preview-f-free',
              evaluations: {
                artificial_analysis_coding_index: 77,
                artificial_analysis_intelligence_index: 62.5,
              },
            }),
          ],
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const map = await syncOnce()
    expect(map.size).toBeGreaterThanOrEqual(1)

    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      data: Array<Record<string, unknown>>
    }
    // find the synced model
    const xprev = body.data.find((m) => m.id === 'opencode/x-preview-f-free') as
      | Record<string, unknown>
      | undefined
    expect(xprev).toBeDefined()
    // enriched fields from sync
    expect(xprev!.pricing).toBeDefined()
    expect(xprev!.pricing).toMatchObject({ prompt: '0', completion: '0' })
    expect(xprev!.quality).toBe(77)
    expect(typeof xprev!.valueScore).toBe('number')
    expect(xprev!.valueScore).toBe(1000) // free → 1000
    expect(xprev!.tier).toBe('budget_free')
    expect(xprev!.lastSyncedAt).toBeDefined()
    expect(typeof xprev!.lastSyncedAt).toBe('number')
    // also snake variants for compatibility
    expect(xprev!.value_score).toBe(1000)
    expect(xprev!.recommended_tier).toBe('budget_free')
    expect(xprev!.coding_index).toBe(77)
    expect(xprev!.intelligence_index).toBe(62.5)

    // GET single also enriched
    const single = await app.request(
      `/v1/models/${encodeURIComponent('opencode/x-preview-f-free')}`,
      {
        headers: { Authorization: `Bearer ${VALID}` },
      },
    )
    expect(single.status).toBe(200)
    const singleBody = (await single.json()) as Record<string, unknown>
    expect(singleBody.pricing).toBeDefined()
    expect(singleBody.quality).toBe(77)
    expect(singleBody.valueScore).toBe(1000)
    expect(singleBody.lastSyncedAt).toBeDefined()
  })

  it('snapshot union: adds snapshot-only ids not in static registry', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('openrouter')) {
        return jsonResponse({
          data: [
            orModel({
              id: 'newprovider/new-model-xyz',
              canonical_slug: 'newprovider/new-model-xyz',
              name: 'New Model',
              context_length: 32_768,
              top_provider: {
                context_length: 32_768,
                max_completion_tokens: 4096,
                is_moderated: false,
              },
              pricing: { prompt: '0.000002', completion: '0.000004' },
              supported_parameters: ['tools'],
              architecture: {
                modality: 'text->text',
                input_modalities: ['text'],
                output_modalities: ['text'],
                tokenizer: 'Test',
                instruct_type: null,
              },
            }),
          ],
        })
      }
      if (u.includes('artificialanalysis')) {
        return jsonResponse({ data: [] })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await syncOnce()
    const app = createApp()
    const res = await app.request('/v1/models', {
      headers: { Authorization: `Bearer ${VALID}` },
    })
    const body = (await res.json()) as { data: Array<{ id: string }> }
    const ids = body.data.map((m) => m.id)
    // static registry ids still there
    expect(ids).toContain('opencode/x-preview-f-free')
    // new snapshot-only id is also exposed
    expect(ids).toContain('newprovider/new-model-xyz')

    // single fetch for that new id works
    const single = await app.request(
      `/v1/models/${encodeURIComponent('newprovider/new-model-xyz')}`,
      {
        headers: { Authorization: `Bearer ${VALID}` },
      },
    )
    expect(single.status).toBe(200)
  })
})
