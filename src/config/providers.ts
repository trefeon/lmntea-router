export interface ProviderSpec {
  baseUrl: string
  apiKeyEnv: string
  relay?: boolean
  timeoutMs: number
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  opencode: {
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    timeoutMs: 30_000,
  },
  commandcode: {
    baseUrl: 'https://api.commandcode.ai/v1',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    timeoutMs: 30_000,
  },
}

export function getProviderForModel(id: string): ProviderSpec | undefined {
  const provider = id.split('/')[0]
  if (provider === undefined || provider.length === 0) return undefined
  return PROVIDERS[provider]
}
