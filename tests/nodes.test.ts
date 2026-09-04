import { beforeEach, describe, expect, it } from 'vitest'
import {
  isNodeModelId,
  nodeModelId,
  resolveNodeForModel,
  resetNodesForTests,
  setNodes,
  type ProviderNode,
} from '../src/config/nodes.js'

const OLLAMA = {
  id: 'custom-ollama',
  format: 'openai' as const,
  baseUrl: 'http://127.0.0.1:11434/v1',
  allowPrivate: true,
  models: [{ id: 'gpt-oss:20b', contextWindow: 131072, maxOutputTokens: 32768 }],
}

const GLHF = {
  id: 'custom-glhf',
  format: 'anthropic' as const,
  baseUrl: 'https://glhf.example/v1',
  models: [{ id: 'free-model' }],
}

describe('provider nodes', () => {
  beforeEach(() => {
    resetNodesForTests()
  })

  it('rejects node ids colliding with builtin provider ids', () => {
    expect(() => setNodes([OLLAMA, { ...OLLAMA, id: 'openai' }])).toThrow(
      /reserved/,
    )
  })

  it('rejects duplicate node ids', () => {
    expect(() => setNodes([OLLAMA, OLLAMA])).toThrow(/duplicate/)
  })

  it('resolves a node model id to a candidate after static miss', () => {
    setNodes([OLLAMA, GLHF])
    const node = resolveNodeForModel('custom-ollama/gpt-oss:20b')
    expect(node?.id).toBe('custom-ollama')
    expect(node?.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(node?.format).toBe('openai')
    expect(node?.allowPrivate).toBe(true)
  })

  it('returns undefined for unknown node or unknown node model', () => {
    setNodes([OLLAMA])
    expect(resolveNodeForModel('custom-nope/model')).toBeUndefined()
    expect(resolveNodeForModel('custom-ollama/unknown-model')).toBeUndefined()
    // builtin ids are never node-resolvable
    expect(resolveNodeForModel('openai/gpt-4o')).toBeUndefined()
  })

  it('declares any model when the node lists none (passthrough nodes)', () => {
    const { models: _omitted, ...passthrough } = OLLAMA
    setNodes([passthrough])
    expect(resolveNodeForModel('custom-ollama/anything')).toBeDefined()
    expect(isNodeModelId('custom-ollama/anything')).toBe(true)
  })

  it('builds canonical model ids under the custom- prefix', () => {
    setNodes([OLLAMA])
    expect(nodeModelId(OLLAMA, 'gpt-oss:20b')).toBe(
      'custom-ollama/gpt-oss:20b',
    )
    expect(isNodeModelId('custom-ollama/gpt-oss:20b')).toBe(true)
    expect(isNodeModelId('openai/gpt-4o')).toBe(false)
  })

  it('rejects SSRF-looking baseUrls without allowPrivate opt-in', () => {
    expect(() =>
      setNodes([
        {
          id: 'custom-meta',
          format: 'openai' as const,
          baseUrl: 'http://169.254.169.254/v1',
        },
      ]),
    ).toThrow(/allowPrivate|private/i)
  })
})
