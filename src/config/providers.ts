import { getModelSpec } from './models.js'

export interface ProviderSpec {
  baseUrl: string
  apiKeyEnv: string
  relay?: boolean
  timeoutMs: number
  passthroughModels?: boolean
  format?: string
  /**
   * Opt-in for local providers on loopback (ollama/vLLM/LM Studio):
   * bypasses the outbound private-hostname SSRF check for THIS provider only.
   * Protocol allowlist + credentials-in-URL rejection still apply.
   */
  allowPrivate?: boolean
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  opencode: {
    // source: src/config/providers.ts c7795ec (original, research/per_model_failure_analysis.md:23)
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    timeoutMs: 30_000,
  },
  commandcode: {
    // source: src/config/providers.ts c7795ec (original, commandcode relay)
    baseUrl: 'https://api.commandcode.ai/v1',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    timeoutMs: 30_000,
  },
  anthropic: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/anthropic/index.ts:5 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:276
    baseUrl: 'https://api.anthropic.com/v1/messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 30000,
    format: 'claude',
  },
  bedrock: {
    // source: https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html — OpenAI-compatible base URL pattern https://bedrock-runtime.{region}.amazonaws.com/openai/v1 (us-east-1 default; reference/OmniRoute .../registry/bedrock/index.ts:4 has no static baseUrl)
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK',
    timeoutMs: 30_000,
    format: 'openai',
  },
  deepseek: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/deepseek/index.ts:4 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:647
    baseUrl: 'https://api.deepseek.com/responses',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    timeoutMs: 30000,
    format: 'openai-responses',
  },
  gemini: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/gemini/index.ts:5 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:164
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    apiKeyEnv: 'GEMINI_API_KEY',
    timeoutMs: 30000,
    format: 'gemini',
  },
  minimax: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/minimax/index.ts:4 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:619
    baseUrl: 'https://api.minimax.io/v1/chat/completions',
    apiKeyEnv: 'MINIMAX_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  moonshot: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/moonshot/index.ts:6 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:437
    baseUrl: 'https://api.moonshot.ai/v1/chat/completions',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  openai: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/openai/index.ts:5 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:111 (spread GPT_5_6_MODEL_SPEC from reference/OmniRoute/src/shared/constants/modelSpecs.ts:90 (GPT_5_6_MODEL_SPEC))
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  volcengine: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/volcengine/index.ts:5
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKeyEnv: 'VOLCENGINE_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  alibaba: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/alibaba/index.ts:4 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:483
    baseUrl:
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyEnv: 'ALIBABA_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'openai',
  },
  cohere: {
    // source: reference/9router/open-sse/providers/registry/cohere.js:2
    baseUrl: 'https://api.cohere.com/compatibility/v1/chat/completions',
    apiKeyEnv: 'COHERE_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  mistral: {
    // source: reference/9router/open-sse/providers/registry/mistral.js:2
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'MISTRAL_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  ollama: {
    // source: reference/9router/open-sse/providers/registry/ollama.js:2
    baseUrl: 'http://localhost:11434',
    apiKeyEnv: '',
    timeoutMs: 30000,
    format: 'ollama',
    allowPrivate: true,
  },
  vertex: {
    // source: reference/9router/open-sse/providers/registry/vertex.js:2
    baseUrl: 'https://aiplatform.googleapis.com',
    apiKeyEnv: 'VERTEX_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'gemini',
  },
  'xiaomi-mimo': {
    // source: reference/OmniRoute/open-sse/config/providers/registry/xiaomi-mimo/index.ts:5 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:523
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'XIAOMI_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },

  openrouter: {
    // source: reference/9router/open-sse/providers/registry/openrouter.js:baseUrl
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'openai',
  },
  requesty: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/requesty/index.ts:baseUrl
    baseUrl: 'https://router.requesty.ai/v1',
    apiKeyEnv: 'REQUESTY_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'openai',
  },
  perplexity: {
    // source: reference/9router/open-sse/providers/registry/perplexity.js:2
    baseUrl: 'https://api.perplexity.ai/chat/completions',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  orcarouter: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/orcarouter/index.ts:baseUrl
    baseUrl: 'https://api.orcarouter.ai/v1',
    apiKeyEnv: 'ORCAROUTER_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'openai',
  },
  aihorde: {
    // source: 9router aihorde registry
    baseUrl: 'https://aihorde.net/api/v2',
    apiKeyEnv: 'AIHORDE_API_KEY',
    timeoutMs: 30000,
    passthroughModels: true,
    format: 'openai',
  },
  together: {
    // source: 9router together.js
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  fireworks: {
    // source: 9router fireworks.js
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  groq: {
    // source: 9router groq.js
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  cerebras: {
    // source: 9router cerebras.js
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  nvidia: {
    // source: 9router nvidia.js
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  nebius: {
    // source: 9router nebius.js
    baseUrl: 'https://api.studio.nebius.ai/v1',
    apiKeyEnv: 'NEBIUS_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  hyperbolic: {
    // source: 9router hyperbolic.js
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    apiKeyEnv: 'HYPERBOLIC_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  siliconflow: {
    // source: 9router siliconflow.js
    baseUrl: 'https://api.siliconflow.com/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  deepinfra: {
    // source: OmniRoute inference-hosts deepinfra
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  huggingface: {
    // source: 9router huggingface.js
    baseUrl: 'https://api-inference.huggingface.co/v1',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    timeoutMs: 30000,
    format: 'openai',
  },
  zai: {
    // source: reference/OmniRoute/open-sse/config/providers/registry/zai/index.ts:5 | reference/OmniRoute/src/shared/constants/modelSpecs.ts:555
    baseUrl: 'https://api.z.ai/api/anthropic/v1/messages',
    apiKeyEnv: 'ZAI_API_KEY',
    timeoutMs: 30000,
    format: 'claude',
  },
}

export function getProviderForModel(id: string): ProviderSpec | undefined {
  const provider = id.split('/')[0]
  if (provider === undefined || provider.length === 0) return undefined
  if (PROVIDERS[provider] !== undefined) return PROVIDERS[provider]
  // Unprefixed alias ids (e.g. 'kimi-k2.7', 'MiniMax-M3') — resolve via the
  // registry entry's `provider` field instead of falling back to a wrong upstream.
  const spec = getModelSpec(id)
  if (spec !== undefined) {
    const alias = PROVIDERS[spec.provider]
    if (alias !== undefined) return alias
  }
  return undefined
}

export function isRelayProvider(id: string): boolean {
  return PROVIDERS[id]?.relay === true
}
