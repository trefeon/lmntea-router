import { describe, expect, it, vi } from 'vitest'

// Partial mock: keep every real export of intelligence/sync.js (models.ts
// depends on getSyncedSnapshot) but spy on startIntelligenceSync so the
// startup guard is observable without opening timers or network.
vi.mock(import('./intelligence/sync.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    startIntelligenceSync: vi.fn(() => ({ stop: () => {} })),
  }
})

import { createApp } from './index.js'
import { startIntelligenceSync } from './intelligence/sync.js'

describe('GET /health via src (legacy, mirrors tests/health.test.ts)', () => {
  it('returns 200 {status:"ok", uptime, version}', async () => {
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; version: string }
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.2.0')
  })
})

describe('server bootstrap — advisory intelligence sync', () => {
  it('startIntelligenceSync is NOT started under vitest runtime', async () => {
    // Importing src/index.ts (and building the app) must not open the
    // background sync interval in test runtimes — VITEST/NODE_ENV guard plus
    // the import.meta.main serve-entry gate both hold here.
    expect(process.env.VITEST).toBe('true')
    const app = createApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(startIntelligenceSync).not.toHaveBeenCalled()
  })
})
