export interface ModelSpec {
  id: string
  provider: string
  contextWindow: number
  maxOutputTokens: number
  minOutputTokens?: number
  supportedParams: Set<string>
  stripParams: Set<string>
  requiresThinkingReconciliation: boolean
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'opencode/x-preview-f-free': {
    id: 'opencode/x-preview-f-free',
    provider: 'opencode',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'opencode/big-pickle': {
    id: 'opencode/big-pickle',
    provider: 'opencode',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'opencode/laguna-s-2.1-free': {
    id: 'opencode/laguna-s-2.1-free',
    provider: 'opencode',
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'opencode/mimo-v2.5-free': {
    id: 'opencode/mimo-v2.5-free',
    provider: 'opencode',
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'opencode/muse-spark-1.2-contributor-free': {
    id: 'opencode/muse-spark-1.2-contributor-free',
    provider: 'opencode',
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    minOutputTokens: 512,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'opencode/hy3-free': {
    id: 'opencode/hy3-free',
    provider: 'opencode',
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
  'commandcode/deepseek/deepseek-v4-flash': {
    id: 'commandcode/deepseek/deepseek-v4-flash',
    provider: 'commandcode',
    contextWindow: 262_144,
    maxOutputTokens: 200_000,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(['temperature', 'top_p']),
    requiresThinkingReconciliation: false,
  },
  'commandcode/gpt-5.6-luna': {
    id: 'commandcode/gpt-5.6-luna',
    provider: 'commandcode',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportedParams: new Set<string>(),
    stripParams: new Set<string>(),
    requiresThinkingReconciliation: false,
  },
}

export function getModelSpec(id: string): ModelSpec | undefined {
  return MODEL_REGISTRY[id]
}
