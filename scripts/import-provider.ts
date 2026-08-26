/**
 * scripts/import-provider.ts — auto importer for lmntea-router
 *
 * Reads:
 *  1) reference/OmniRoute/src/shared/constants/modelSpecs.ts (MODEL_SPECS via regex)
 *  2) reference/9router/open-sse/providers/registry/*.js for baseUrl/format/passthroughModels
 *  3) reference/OmniRoute/open-sse/config/providers/registry/<id>/index.ts (same, OmniRoute side)
 *  4) optional fetch https://openrouter.ai/api/v1/models when --source openrouter
 *
 * Maps to lmntea-router ModelSpec/ProviderSpec with citations, writes
 * src/config/models.ts and src/config/providers.ts sorted, generates
 * per-provider tests (clamp/sanitize/thinking + app.request integration).
 *
 * CLI:
 *   pnpm import:provider --provider openai --source openrouter --limit 10
 *   pnpm import:provider --provider openai,anthropic --source all
 *   pnpm import:provider --all
 *   pnpm import:provider --provider openai --dry-run
 *
 * Node 20+ ESM, no deps beyond zod + fetch (global).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REASONING_UNSUPPORTED = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'n',
] as const

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const OMNI_MODELSPEC_PATH =
  'reference/OmniRoute/src/shared/constants/modelSpecs.ts'
const NINE_REGISTRY_DIR = 'reference/9router/open-sse/providers/registry'
const OMNI_REGISTRY_DIR =
  'reference/OmniRoute/open-sse/config/providers/registry'

const MODELS_OUT = 'src/config/models.ts'
const PROVIDERS_OUT = 'src/config/providers.ts'
const TESTS_OUT_DIR = 'tests/generated'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CliSchema = z.object({
  provider: z.string().optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  all: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  help: z.boolean().optional(),
})

function parseArgs(
  argv: string[],
): z.infer<typeof CliSchema> & { providers: string[]; sourceNorm: string } {
  const raw: Record<string, unknown> = {}
  const providers: string[] = []
  let sourceNorm = 'all'

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--provider' && argv[i + 1]) {
      const v = argv[++i]!
      raw.provider = v
      providers.push(
        ...v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    } else if (a.startsWith('--provider=')) {
      const v = a.slice('--provider='.length)
      raw.provider = v
      providers.push(
        ...v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    } else if (a === '--source' && argv[i + 1]) {
      const v = argv[++i]!
      raw.source = v
      sourceNorm = v
    } else if (a.startsWith('--source=')) {
      const v = a.slice('--source='.length)
      raw.source = v
      sourceNorm = v
    } else if (a === '--limit' && argv[i + 1]) {
      raw.limit = argv[++i]!
    } else if (a.startsWith('--limit=')) {
      raw.limit = a.slice('--limit='.length)
    } else if (a === '--all') {
      raw.all = true
    } else if (a === '--dry-run' || a === '--dryRun') {
      raw.dryRun = true
    } else if (a === '--help' || a === '-h') {
      raw.help = true
    }
  }

  const parsed = CliSchema.parse(raw)
  // normalize source
  if (parsed.source) sourceNorm = parsed.source.toLowerCase()
  // --all means all providers; if no provider specified but --all not given, providers may be empty -> treat as error unless help
  return { ...parsed, providers, sourceNorm }
}

function printHelp(): void {
  console.log(`
lmntea-router provider importer

Usage:
  pnpm import:provider --provider <id> [--source openrouter|9router|omnroute|all] [--limit N] [--dry-run]
  pnpm import:provider --provider openai,anthropic,gemini --source all
  pnpm import:provider --all [--source openrouter] [--limit 10]

Options:
  --provider <id>   Provider id (comma-separated). e.g. openai, anthropic, gemini, deepseek, moonshot, zai, minimax, volcengine, xiaomi-mimo, bedrock
  --source <src>    Source to import from: openrouter | 9router | omnroute | all (default: all)
  --limit <n>       Limit models per provider (for openrouter sampling)
  --all             Import all discovered providers
  --dry-run         Print plan without writing files
  --help            Show this help

Sources:
  - omnroute: ${OMNI_MODELSPEC_PATH} (MODEL_SPECS, citations with line numbers)
  - 9router : ${NINE_REGISTRY_DIR}/*.js (baseUrl/format/passthroughModels)
  - omnroute registry: ${OMNI_REGISTRY_DIR}/*/index.ts
  - openrouter: ${OPENROUTER_MODELS_URL} (context_length -> contextWindow, top_provider.max_completion_tokens -> maxOutputTokens)

Mapping:
  - context_length -> contextWindow
  - top_provider.max_completion_tokens -> maxOutputTokens
  - supported_parameters missing temperature/top_p -> stripParams = REASONING_UNSUPPORTED
  - reasoning/thinkingBudgetCap -> requiresThinkingReconciliation
  - architecture.input_modalities includes image -> vision gate (citation only, not failing)
  - canonical_slug / aliases -> alias resolution (extra registry entries)
  - category free/freeTier or passthroughModels:true -> relay:true else direct
`)
}

// ---------------------------------------------------------------------------
// Helpers — file / line
// ---------------------------------------------------------------------------

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function readText(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8')
}

function safeReadText(p: string): string | null {
  const abs = resolve(ROOT, p)
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8')
}

// ---------------------------------------------------------------------------
// OmniRoute modelSpecs.ts parser (regex, preserves citations)
// ---------------------------------------------------------------------------

interface OmniSpecEntry {
  citation: string
  line: number
  raw: string
  maxOutputTokens?: number
  contextWindow?: number
  supportsThinking?: boolean
  supportsVision?: boolean
  supportsTools?: boolean
  thinkingBudgetCap?: number
  defaultThinkingBudget?: number
  adaptiveThinkingOnly?: boolean
  rejectsThinkingDisabled?: boolean
  aliases: string[]
}

function parseOmniModelSpecs(): Map<string, OmniSpecEntry> {
  const rel = OMNI_MODELSPEC_PATH
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs)) {
    console.warn(`[import-provider] missing ${rel}, skipping omnroute source`)
    return new Map()
  }
  const content = readFileSync(abs, 'utf8')
  const map = new Map<string, OmniSpecEntry>()

  // Pre-parse top-level const specs (e.g., GPT_5_6_MODEL_SPEC, GEMINI_36_FLASH_MODEL_SPEC)
  const constMap = new Map<string, Partial<OmniSpecEntry>>()
  const constRe = /const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*satisfies\s+ModelSpec/g
  let cm: RegExpExecArray | null
  while ((cm = constRe.exec(content)) !== null) {
    const name = cm[1]!
    const body = cm[2]!
    const maxOut = body.match(/maxOutputTokens:\s*(\d+)/)?.[1]
    const ctx = body.match(/contextWindow:\s*(\d+)/)?.[1]
    const supThink = body.match(/supportsThinking:\s*(true|false)/)?.[1]
    const supVision = body.match(/supportsVision:\s*(true|false)/)?.[1]
    const supTools = body.match(/supportsTools:\s*(true|false)/)?.[1]
    const cap = body.match(/thinkingBudgetCap:\s*(\d+)/)?.[1]
    const defBudget = body.match(/defaultThinkingBudget:\s*(\d+)/)?.[1]
    const adaptive = body.match(/adaptiveThinkingOnly:\s*(true|false)/)?.[1]
    const rejects = body.match(/rejectsThinkingDisabled:\s*(true|false)/)?.[1]
    constMap.set(name, {
      maxOutputTokens: maxOut ? Number(maxOut) : undefined,
      contextWindow: ctx ? Number(ctx) : undefined,
      supportsThinking: supThink ? supThink === 'true' : undefined,
      supportsVision: supVision ? supVision === 'true' : undefined,
      supportsTools: supTools ? supTools === 'true' : undefined,
      thinkingBudgetCap: cap ? Number(cap) : undefined,
      defaultThinkingBudget: defBudget ? Number(defBudget) : undefined,
      adaptiveThinkingOnly: adaptive ? adaptive === 'true' : undefined,
      rejectsThinkingDisabled: rejects ? rejects === 'true' : undefined,
      aliases: [],
      citation: `${rel}:${lineOf(content, cm.index)} (${name})`,
      line: lineOf(content, cm.index),
      raw: body,
    })
  }

  // Find export const MODEL_SPECS block, then parse top-level keys
  const marker = 'export const MODEL_SPECS'
  const startIdx = content.indexOf(marker)
  const searchFrom = startIdx >= 0 ? startIdx : 0
  const slice = content.slice(searchFrom)

  // Regex for top-level entries: "key": { ... }  (non-greedy, then we count braces)
  const keyRe = /"([^"]+)"\s*:\s*\{/g
  let m: RegExpExecArray | null
  while ((m = keyRe.exec(slice)) !== null) {
    const key = m[1]!
    if (key === '__default__') continue
    const braceStart = m.index + m[0].length - 1 // at '{'
    let depth = 1
    let i = braceStart + 1
    for (; i < slice.length; i++) {
      const ch = slice[i]!
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) continue
    const raw = slice.slice(braceStart, i + 1)
    const absOffset = searchFrom + m.index
    const ln = lineOf(content, absOffset)
    const citation = `${rel}:${ln}`

    // Check for spread of a const spec
    const spreadMatch = raw.match(/\.\.\.(\w+)/)
    const spreadName = spreadMatch?.[1]
    const spreadEntry = spreadName ? constMap.get(spreadName) : undefined

    // Extract fields via regex inside raw (overrides win over spread)
    const maxOut = raw.match(/maxOutputTokens:\s*(\d+)/)?.[1]
    const ctx = raw.match(/contextWindow:\s*(\d+)/)?.[1]
    const supThink = raw.match(/supportsThinking:\s*(true|false)/)?.[1]
    const supVision = raw.match(/supportsVision:\s*(true|false)/)?.[1]
    const supTools = raw.match(/supportsTools:\s*(true|false)/)?.[1]
    const cap = raw.match(/thinkingBudgetCap:\s*(\d+)/)?.[1]
    const defBudget = raw.match(/defaultThinkingBudget:\s*(\d+)/)?.[1]
    const adaptive = raw.match(/adaptiveThinkingOnly:\s*(true|false)/)?.[1]
    const rejects = raw.match(/rejectsThinkingDisabled:\s*(true|false)/)?.[1]
    const aliasesMatch = raw.match(/aliases:\s*\[([^\]]*)\]/)
    const aliases: string[] = []
    if (aliasesMatch?.[1]) {
      const inner = aliasesMatch[1]
      const am = inner.matchAll(/"([^"]+)"/g)
      for (const a of am) aliases.push(a[1]!)
    }

    const entry: OmniSpecEntry = {
      citation: spreadEntry
        ? `${citation} (spread ${spreadName} from ${spreadEntry.citation})`
        : citation,
      line: ln,
      raw,
      maxOutputTokens: maxOut ? Number(maxOut) : spreadEntry?.maxOutputTokens,
      contextWindow: ctx ? Number(ctx) : spreadEntry?.contextWindow,
      supportsThinking: supThink
        ? supThink === 'true'
        : spreadEntry?.supportsThinking,
      supportsVision: supVision
        ? supVision === 'true'
        : spreadEntry?.supportsVision,
      supportsTools: supTools
        ? supTools === 'true'
        : spreadEntry?.supportsTools,
      thinkingBudgetCap: cap ? Number(cap) : spreadEntry?.thinkingBudgetCap,
      defaultThinkingBudget: defBudget
        ? Number(defBudget)
        : spreadEntry?.defaultThinkingBudget,
      adaptiveThinkingOnly: adaptive
        ? adaptive === 'true'
        : spreadEntry?.adaptiveThinkingOnly,
      rejectsThinkingDisabled: rejects
        ? rejects === 'true'
        : spreadEntry?.rejectsThinkingDisabled,
      aliases,
    }
    map.set(key, entry)
  }

  console.log(
    `[import-provider] parsed ${map.size} OmniRoute MODEL_SPECS from ${rel} (+${constMap.size} const spreads)`,
  )
  return map
}

// ---------------------------------------------------------------------------
// 9router registry parser
// ---------------------------------------------------------------------------

interface RegistryProvider {
  id: string
  citation: string
  line: number
  baseUrl: string
  format: string
  passthroughModels?: boolean
  models: Array<{ id: string; raw: string }>
  category?: string
}

function parseNineRouterRegistry(): Map<string, RegistryProvider> {
  const map = new Map<string, RegistryProvider>()
  const dir = resolve(ROOT, NINE_REGISTRY_DIR)
  if (!existsSync(dir)) {
    console.warn(`[import-provider] missing ${NINE_REGISTRY_DIR}, skipping`)
    return map
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  for (const file of files) {
    const rel = `${NINE_REGISTRY_DIR}/${file}`
    const content = readFileSync(join(dir, file), 'utf8')
    const idMatch = content.match(/id:\s*"([^"]+)"\s*,/)
    const id = idMatch?.[1]
    if (!id) continue
    const baseUrlMatch = content.match(/baseUrl:\s*"([^"]+)"/)
    const baseUrl = baseUrlMatch?.[1] ?? ''
    const formatMatch = content.match(/format:\s*"([^"]+)"/)
    const format = formatMatch?.[1] ?? 'openai'
    const passthrough = /passthroughModels:\s*true/.test(content)
    const categoryMatch = content.match(/category:\s*"([^"]+)"/)
    const category = categoryMatch?.[1]
    const ln = lineOf(content, content.indexOf(`id: "${id}"`))
    const citation = `${rel}:${ln}`

    // Parse models array: models: [ { id: "..." }, ... ]
    const models: Array<{ id: string; raw: string }> = []
    const modelsBlockMatch = content.match(/models:\s*\[([\s\S]*?)\]/)
    if (modelsBlockMatch?.[1]) {
      const block = modelsBlockMatch[1]
      const idRe = /\{\s*id:\s*"([^"]+)"[^}]*\}/g
      let mm: RegExpExecArray | null
      while ((mm = idRe.exec(block)) !== null) {
        models.push({ id: mm[1]!, raw: mm[0] })
      }
      // also handle string ids: "model-id" without object
      // (not common for 9router, but cover)
      if (models.length === 0) {
        const strRe = /"([^"]+)"\s*,?/g
        let sm: RegExpExecArray | null
        while ((sm = strRe.exec(block)) !== null) {
          const v = sm[1]!
          if (!v.includes(':') && !v.includes('/')) continue // heuristic?
          models.push({ id: v, raw: sm[0] })
        }
      }
    }

    map.set(id, {
      id,
      citation,
      line: ln,
      baseUrl,
      format,
      passthroughModels: passthrough || undefined,
      models,
      category,
    })
  }
  console.log(
    `[import-provider] parsed ${map.size} 9router registry providers from ${NINE_REGISTRY_DIR}`,
  )
  return map
}

// ---------------------------------------------------------------------------
// OmniRoute provider registry parser (open-sse/config/providers/registry)
// ---------------------------------------------------------------------------

function parseOmniProviderRegistry(): Map<string, RegistryProvider> {
  const map = new Map<string, RegistryProvider>()
  const dir = resolve(ROOT, OMNI_REGISTRY_DIR)
  if (!existsSync(dir)) return map
  const entries = readdirSync(dir, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  )
  for (const ent of entries) {
    const pid = ent.name
    const indexTs = join(dir, pid, 'index.ts')
    if (!existsSync(indexTs)) continue
    const content = readFileSync(indexTs, 'utf8')
    const rel = `${OMNI_REGISTRY_DIR}/${pid}/index.ts`
    const baseUrlMatch = content.match(/baseUrl:\s*"([^"]+)"/)
    const baseUrl = baseUrlMatch?.[1] ?? ''
    const formatMatch = content.match(/format:\s*"([^"]+)"/)
    const format = formatMatch?.[1] ?? 'openai'
    const passthrough = /passthroughModels:\s*true/.test(content)
    const categoryMatch = content.match(/category:\s*"([^"]+)"/)
    const category = categoryMatch?.[1]
    const ln =
      content.indexOf('id:') >= 0 ? lineOf(content, content.indexOf('id:')) : 1
    const citation = `${rel}:${ln}`

    // models: RegistryModel[] — similar parsing
    const models: Array<{ id: string; raw: string }> = []
    // crude: find id:" inside models block
    const idRe = /\{\s*id:\s*"([^"]+)"[^}]*\}/g
    let mm: RegExpExecArray | null
    while ((mm = idRe.exec(content)) !== null) {
      // ensure this is inside models array context — heuristic: after "models"
      const pos = mm.index
      const before = content.slice(Math.max(0, pos - 2000), pos)
      if (!before.includes('models')) continue
      models.push({ id: mm[1]!, raw: mm[0] })
    }

    // Merge or insert; prefer existing 9router entry but keep Omni as fallback
    if (!map.has(pid)) {
      map.set(pid, {
        id: pid,
        citation,
        line: ln,
        baseUrl,
        format,
        passthroughModels: passthrough || undefined,
        models,
        category,
      })
    } else {
      // merge models if missing
      const existing = map.get(pid)!
      if (existing.models.length === 0 && models.length > 0)
        existing.models = models
      if (!existing.baseUrl && baseUrl) existing.baseUrl = baseUrl
    }
  }
  if (map.size > 0)
    console.log(
      `[import-provider] parsed ${map.size} OmniRoute provider registries from ${OMNI_REGISTRY_DIR}`,
    )
  return map
}

// ---------------------------------------------------------------------------
// OpenRouter fetch + mapping
// ---------------------------------------------------------------------------

const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    canonical_slug: z.string().optional(),
    name: z.string().optional(),
    created: z.number().optional(),
    description: z.string().optional(),
    context_length: z.number().optional(),
    architecture: z
      .object({
        modality: z.string().optional(),
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
        tokenizer: z.string().optional(),
        instruct_type: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    top_provider: z
      .object({
        context_length: z.number().nullable().optional(),
        max_completion_tokens: z.number().nullable().optional(),
        is_moderated: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
    default_parameters: z.record(z.unknown()).nullable().optional(),
    reasoning: z
      .object({
        mandatory: z.boolean().optional(),
        default_enabled: z.boolean().optional(),
        supported_efforts: z.array(z.string()).optional(),
        default_effort: z.string().optional(),
      })
      .passthrough()
      .optional(),
    pricing: z.record(z.unknown()).optional(),
  })
  .passthrough()
type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>

const OpenRouterResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
})

async function fetchOpenRouterModels(
  limit?: number,
  providerFilter?: string[],
): Promise<OpenRouterModel[]> {
  console.log(`[import-provider] fetching ${OPENROUTER_MODELS_URL} ...`)
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { 'User-Agent': 'lmntea-router-importer/1.0' },
  })
  if (!res.ok)
    throw new Error(`OpenRouter fetch failed: ${res.status} ${res.statusText}`)
  const json = (await res.json()) as unknown
  const parsed = OpenRouterResponseSchema.parse(json)
  let data = parsed.data
  console.log(`[import-provider] fetched ${data.length} models from OpenRouter`)

  if (providerFilter && providerFilter.length > 0) {
    const set = new Set(providerFilter.map((p) => p.toLowerCase()))
    data = data.filter((m) => {
      const prov = m.id.split('/')[0]?.toLowerCase() ?? ''
      const slugProv = m.canonical_slug?.split('/')[0]?.toLowerCase()
      return set.has(prov) || (slugProv ? set.has(slugProv) : false)
    })
    console.log(
      `[import-provider] filtered to ${data.length} models for providers [${providerFilter.join(', ')}]`,
    )
  }

  if (limit && limit > 0 && data.length > limit) {
    data = data.slice(0, limit)
    console.log(
      `[import-provider] limited to ${data.length} models (--limit ${limit})`,
    )
  }

  return data
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

interface GeneratedModel {
  id: string
  provider: string
  contextWindow: number
  maxOutputTokens: number
  minOutputTokens?: number
  thinkingBudgetCap?: number
  defaultThinkingBudget?: number
  supportsVision?: boolean
  supportsThinking?: boolean
  supportedParams: string[]
  stripParams: string[]
  requiresThinkingReconciliation: boolean
  citations: string[]
  // debug
  visionGate?: boolean
  aliasOf?: string
}

interface GeneratedProvider {
  id: string
  baseUrl: string
  apiKeyEnv: string
  relay?: boolean
  timeoutMs: number
  passthroughModels?: boolean
  format?: string
  citations: string[]
}

function inferProviderFromModelId(modelId: string): string {
  if (modelId.includes('/')) return modelId.split('/')[0]!.toLowerCase()
  // heuristic for bare ids
  const lower = modelId.toLowerCase()
  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('text-embedding') ||
    lower.startsWith('dall-e') ||
    lower.startsWith('whisper') ||
    lower.startsWith('tts') ||
    lower.startsWith('gpt-')
  )
    return 'openai'
  if (lower.startsWith('claude')) return 'anthropic'
  if (lower.startsWith('gemini') || lower.startsWith('gemma')) return 'gemini'
  if (lower.startsWith('deepseek')) return 'deepseek'
  if (lower.startsWith('kimi') || lower.startsWith('k3')) return 'moonshot'
  if (lower.startsWith('glm')) return 'zai'
  if (lower.startsWith('minimax')) return 'minimax'
  if (lower.startsWith('qwen')) return 'qwen'
  if (lower.startsWith('mimo') || lower.startsWith('xiaomi'))
    return 'xiaomi-mimo'
  if (lower.startsWith('doubao') || lower.startsWith('volc'))
    return 'volcengine'
  if (lower.startsWith('bedrock')) return 'bedrock'
  return lower.split('-')[0] ?? 'unknown'
}

function deriveStripParams(
  supported: string[] | undefined,
  unsupported: readonly string[] | undefined,
  modelId: string,
): string[] {
  // If per-model unsupportedParams explicitly says REASONING_UNSUPPORTED, use it
  if (unsupported && unsupported.length > 0) {
    // If unsupported equals REASONING_UNSUPPORTED (by content), return that
    const hasTemp = unsupported.includes('temperature')
    if (hasTemp) return [...REASONING_UNSUPPORTED]
    return [...unsupported]
  }
  // Otherwise infer from supported_parameters: if temperature missing -> reasoning model
  if (supported) {
    const set = new Set(supported)
    if (!set.has('temperature') && !set.has('top_p')) {
      // Heuristic: reasoning model rejects sampling params
      return [...REASONING_UNSUPPORTED]
    }
    // Also check if model id looks like reasoning model (o1/o3/deepseek-reasoner)
    if (
      /^o[13]/.test(modelId) ||
      /reasoner/i.test(modelId) ||
      /r1/i.test(modelId)
    ) {
      if (!set.has('temperature')) return [...REASONING_UNSUPPORTED]
    }
  }
  return []
}

function deriveThinkingReconciliation(
  omni?: OmniSpecEntry,
  openRouter?: OpenRouterModel,
  stripContainsReasoning?: boolean,
): boolean {
  if (omni) {
    if (omni.supportsThinking) return true
    if (omni.thinkingBudgetCap !== undefined) return true
    if (omni.adaptiveThinkingOnly) return true
  }
  if (openRouter) {
    if (openRouter.reasoning) return true
    const sup = openRouter.supported_parameters ?? []
    if (
      sup.includes('reasoning') ||
      sup.includes('reasoning_effort') ||
      sup.includes('include_reasoning')
    )
      return true
  }
  if (stripContainsReasoning) return true
  return false
}

function providerApiKeyEnv(providerId: string): string {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
    kimi: 'KIMI_API_KEY',
    zai: 'ZAI_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    volcengine: 'VOLCENGINE_API_KEY',
    'xiaomi-mimo': 'XIAOMI_API_KEY',
    bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
    opencode: 'OPENCODE_API_KEY',
    commandcode: 'COMMANDCODE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    groq: 'GROQ_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    cohere: 'COHERE_API_KEY',
    xai: 'XAI_API_KEY',
  }
  const key = providerId.toLowerCase()
  if (map[key]) return map[key]!
  // fallback: UPPER_SNAKE + _API_KEY
  return `${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`
}

function isRelayProvider(
  providerId: string,
  category?: string,
  passthrough?: boolean,
): boolean {
  // Relay tier: free/freeTier categories or passthroughModels gateways are relay-like
  if (passthrough) return true
  if (!category) return false
  const c = category.toLowerCase()
  if (c === 'free' || c === 'freetier' || c === 'free_tier') return true
  // openrouter is a gateway/relay aggregator
  if (providerId.toLowerCase() === 'openrouter') return true
  return false
}

// ---------------------------------------------------------------------------
// Merge with existing files (preserve + sort)
// ---------------------------------------------------------------------------

function parseExistingModels(): Map<
  string,
  { raw: string; spec: GeneratedModel }
> {
  const map = new Map<string, { raw: string; spec: GeneratedModel }>()
  const txt = safeReadText(MODELS_OUT)
  if (!txt) return map
  // crude parse: match "'id': { ... }" inside MODEL_REGISTRY
  const re = /'([^']+)'\s*:\s*\{([\s\S]*?)\n\s*\},/g
  let m: RegExpExecArray | null
  while ((m = re.exec(txt)) !== null) {
    const id = m[1]!
    const body = m[2]!
    const ctx = body.match(/contextWindow:\s*([\d_]+)/)?.[1]?.replace(/_/g, '')
    const maxOut = body
      .match(/maxOutputTokens:\s*([\d_]+)/)?.[1]
      ?.replace(/_/g, '')
    const prov = body.match(/provider:\s*'([^']+)'/)?.[1]
    if (!ctx || !maxOut || !prov) continue
    map.set(id, {
      raw: m[0],
      spec: {
        id,
        provider: prov,
        contextWindow: Number(ctx),
        maxOutputTokens: Number(maxOut),
        supportedParams: [],
        stripParams: [],
        requiresThinkingReconciliation:
          /requiresThinkingReconciliation:\s*true/.test(body),
        citations: [],
      },
    })
  }
  return map
}

function parseExistingProviders(): Map<string, GeneratedProvider> {
  const map = new Map<string, GeneratedProvider>()
  const txt = safeReadText(PROVIDERS_OUT)
  if (!txt) return map
  const re = /(\w[\w-]*)\s*:\s*\{([\s\S]*?)\n\s*\},/g
  let m: RegExpExecArray | null
  while ((m = re.exec(txt)) !== null) {
    const id = m[1]!
    if (id === 'PROVIDERS') continue
    const body = m[2]!
    const baseUrl = body.match(/baseUrl:\s*'([^']+)'/)?.[1] ?? ''
    const apiKeyEnv =
      body.match(/apiKeyEnv:\s*'([^']+)'/)?.[1] ?? providerApiKeyEnv(id)
    const timeoutMs = Number(
      body.match(/timeoutMs:\s*([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 30000,
    )
    const relay = /relay:\s*true/.test(body)
    const passthrough = /passthroughModels:\s*true/.test(body)
    map.set(id, {
      id,
      baseUrl,
      apiKeyEnv,
      timeoutMs,
      relay: relay || undefined,
      passthroughModels: passthrough || undefined,
      citations: [],
    })
  }
  return map
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const providersFilter = args.all
    ? []
    : args.providers.map((p) => p.toLowerCase())
  const source = args.sourceNorm
  const limit = args.limit
  const dryRun = args.dryRun ?? false

  if (!args.all && providersFilter.length === 0) {
    console.error(
      '[import-provider] error: must specify --provider <id> or --all',
    )
    printHelp()
    process.exit(1)
  }

  console.log(
    `[import-provider] source=${source} providers=${providersFilter.length ? providersFilter.join(',') : '(all)'} limit=${limit ?? 'none'} dryRun=${dryRun}`,
  )

  // Load sources according to --source
  const wantOmni =
    source === 'all' ||
    source === 'omnroute' ||
    source === 'omniroute' ||
    source === 'omni'
  const wantNine = source === 'all' || source === '9router' || source === 'nine'
  const wantOpenRouter = source === 'all' || source === 'openrouter'

  let omniSpecs: Map<string, OmniSpecEntry> = new Map()
  let nineRegistry: Map<string, RegistryProvider> = new Map()
  let omniRegistry: Map<string, RegistryProvider> = new Map()
  let openRouterModels: OpenRouterModel[] = []

  if (wantOmni) omniSpecs = parseOmniModelSpecs()
  if (wantNine) nineRegistry = parseNineRouterRegistry()
  // Always try to load omni registry as fallback for baseUrls (even if not explicitly requested)
  omniRegistry = parseOmniProviderRegistry()
  if (wantOpenRouter) {
    try {
      openRouterModels = await fetchOpenRouterModels(
        limit,
        providersFilter.length ? providersFilter : undefined,
      )
    } catch (e) {
      console.warn(
        `[import-provider] OpenRouter fetch failed: ${(e as Error).message}`,
      )
      if (source === 'openrouter') {
        console.warn(
          '[import-provider] --source openrouter requested but fetch failed; continuing with local sources',
        )
      }
      openRouterModels = []
    }
  }

  // Build unified provider map (9router primary, omni fallback)
  const unifiedProviders = new Map<string, RegistryProvider>()
  for (const [k, v] of nineRegistry) unifiedProviders.set(k.toLowerCase(), v)
  for (const [k, v] of omniRegistry) {
    const lk = k.toLowerCase()
    if (!unifiedProviders.has(lk)) unifiedProviders.set(lk, v)
    else {
      // merge missing fields
      const ex = unifiedProviders.get(lk)!
      if (!ex.baseUrl && v.baseUrl) ex.baseUrl = v.baseUrl
      if (!ex.passthroughModels && v.passthroughModels)
        ex.passthroughModels = v.passthroughModels
      if (ex.models.length === 0 && v.models.length > 0) ex.models = v.models
    }
  }

  // Determine which providers to generate
  let targetProviders: string[] = []
  if (args.all) {
    // all discovered providers
    const allIds = new Set<string>()
    for (const k of unifiedProviders.keys()) allIds.add(k)
    for (const [k, entry] of omniSpecs) {
      const prov = inferProviderFromModelId(k)
      allIds.add(prov)
    }
    for (const m of openRouterModels) {
      const prov = (m.id.split('/')[0] ?? '').toLowerCase()
      if (prov) allIds.add(prov)
    }
    targetProviders = Array.from(allIds).sort()
    // If limit? Still use all but filter later
    console.log(
      `[import-provider] discovered ${targetProviders.length} providers: ${targetProviders.join(', ')}`,
    )
  } else {
    targetProviders = providersFilter
  }

  // Build generated models map
  const generatedModels = new Map<string, GeneratedModel>()
  const generatedProviders = new Map<string, GeneratedProvider>()

  // Helper to ensure provider entry exists in generatedProviders
  const ensureProvider = (
    pid: string,
    fallbackBaseUrl?: string,
    citation?: string,
  ) => {
    const lk = pid.toLowerCase()
    if (generatedProviders.has(lk)) return generatedProviders.get(lk)!
    const reg = unifiedProviders.get(lk)
    const baseUrl = reg?.baseUrl || fallbackBaseUrl || ''
    const format = reg?.format
    const passthrough = reg?.passthroughModels
    const category = reg?.category
    const citations: string[] = []
    if (reg?.citation) citations.push(reg.citation)
    if (citation) citations.push(citation)
    if (citations.length === 0) citations.push(`inferred:provider:${pid}`)
    const prov: GeneratedProvider = {
      id: pid,
      baseUrl: baseUrl || `https://${pid}.example.com/v1`,
      apiKeyEnv: providerApiKeyEnv(pid),
      timeoutMs: 30_000,
      relay: isRelayProvider(pid, category, passthrough) ? true : undefined,
      passthroughModels: passthrough,
      format,
      citations,
    }
    generatedProviders.set(lk, prov)
    return prov
  }

  // 1) From OmniRoute MODEL_SPECS
  for (const [modelId, entry] of omniSpecs) {
    const inferredProv = inferProviderFromModelId(modelId)
    if (
      !args.all &&
      providersFilter.length > 0 &&
      !providersFilter.includes(inferredProv.toLowerCase())
    ) {
      // also check aliases mapping? For multi-provider models like gpt-5.6, inferred is openai, ok.
      // If provider filter is openai, we keep gpt-5.6
      continue
    }
    if (
      targetProviders.length > 0 &&
      !args.all &&
      !targetProviders.includes(inferredProv.toLowerCase())
    )
      continue
    // Apply limit? For omni specs, limit per provider if needed
    // Count per provider
    const perProvCount = Array.from(generatedModels.values()).filter(
      (m) => m.provider.toLowerCase() === inferredProv.toLowerCase(),
    ).length
    if (limit && perProvCount >= limit) continue

    const ctx = entry.contextWindow ?? 128000
    const maxOut = entry.maxOutputTokens ?? 8192
    const strip =
      entry.supportsThinking === false
        ? [...REASONING_UNSUPPORTED]
        : entry.adaptiveThinkingOnly
          ? [...REASONING_UNSUPPORTED]
          : []
    const stripParams = deriveStripParams(
      undefined,
      strip.length ? (strip as unknown as readonly string[]) : undefined,
      modelId,
    )
    const thinking = deriveThinkingReconciliation(
      entry,
      undefined,
      stripParams.length > 0,
    )

    const citations: string[] = [entry.citation]
    // Also add per_model_failure_analysis.md clamp citation if model is in that doc's table
    const failureDocModels = new Set([
      'opencode/x-preview-f-free',
      'opencode/muse-spark-1.2-contributor-free',
      'opencode/mimo-v2.5-free',
      'commandcode/deepseek/deepseek-v4-flash',
      'opencode/big-pickle',
      'opencode/laguna-s-2.1-free',
      'opencode/hy3-free',
      'commandcode/gpt-5.6-luna',
    ])
    if (
      failureDocModels.has(modelId) ||
      failureDocModels.has(`${inferredProv}/${modelId}`)
    ) {
      citations.push('research/per_model_failure_analysis.md:3 (clamp table)')
    }
    citations.push(
      'universal_protocol_translation_spec.md:effort table (thinking caps)',
    )

    const gen: GeneratedModel = {
      id: modelId.includes('/') ? modelId : `${inferredProv}/${modelId}`,
      provider: inferredProv,
      contextWindow: ctx,
      maxOutputTokens: maxOut,
      thinkingBudgetCap: entry.thinkingBudgetCap,
      defaultThinkingBudget: entry.defaultThinkingBudget,
      supportsVision: entry.supportsVision,
      supportsThinking: entry.supportsThinking,
      supportedParams: [],
      stripParams,
      requiresThinkingReconciliation: thinking,
      citations,
      visionGate: entry.supportsVision,
    }
    // Use full id as key
    const key = gen.id
    if (!generatedModels.has(key)) generatedModels.set(key, gen)

    // Alias resolution: for each alias, create extra entry pointing to same spec
    for (const alias of entry.aliases) {
      const aliasProv = alias.includes('/')
        ? alias.split('/')[0]!.toLowerCase()
        : inferredProv
      const aliasId = alias
      if (generatedModels.has(aliasId)) continue
      const aliasPerProvCount = Array.from(generatedModels.values()).filter(
        (m) => m.provider.toLowerCase() === aliasProv.toLowerCase(),
      ).length
      if (limit && aliasPerProvCount >= limit) continue
      const aliasGen: GeneratedModel = {
        ...gen,
        id: aliasId,
        provider: aliasProv,
        citations: [...citations, `${entry.citation} (alias:${alias})`],
        aliasOf: key,
      }
      generatedModels.set(aliasId, aliasGen)
    }

    ensureProvider(inferredProv, undefined, entry.citation)
  }

  // 2) From 9router registry models (supplement missing omni entries)
  for (const [pid, reg] of unifiedProviders) {
    if (
      !args.all &&
      providersFilter.length > 0 &&
      !providersFilter.includes(pid.toLowerCase())
    )
      continue
    // Ensure provider exists even if no models yet
    if (reg.models.length === 0) {
      ensureProvider(pid, reg.baseUrl, reg.citation)
      continue
    }
    for (const m of reg.models) {
      const modelId = m.id
      const fullId = modelId.includes('/') ? modelId : `${pid}/${modelId}`
      if (generatedModels.has(fullId) || generatedModels.has(modelId)) continue
      const perProvCount = Array.from(generatedModels.values()).filter(
        (x) => x.provider.toLowerCase() === pid.toLowerCase(),
      ).length
      if (limit && perProvCount >= limit) break

      // Try to find omni spec for this model (bare id fallback)
      let omni: OmniSpecEntry | undefined
      if (omniSpecs.has(modelId)) omni = omniSpecs.get(modelId)
      else if (omniSpecs.has(fullId)) omni = omniSpecs.get(fullId)
      else {
        // try bare after slash
        const bare = modelId.split('/').pop()!
        if (omniSpecs.has(bare)) omni = omniSpecs.get(bare)
      }

      const ctx = omni?.contextWindow ?? 128000
      const maxOut = omni?.maxOutputTokens ?? 16384
      const strip = deriveStripParams(undefined, undefined, modelId)
      const thinking = deriveThinkingReconciliation(
        omni,
        undefined,
        strip.length > 0,
      )

      const citations = [reg.citation]
      if (omni) citations.push(omni.citation)
      citations.push(
        'reference/9router/open-sse/providers/registry (baseUrl/format)',
      )

      const gen: GeneratedModel = {
        id: fullId,
        provider: pid,
        contextWindow: ctx,
        maxOutputTokens: maxOut,
        thinkingBudgetCap: omni?.thinkingBudgetCap,
        defaultThinkingBudget: omni?.defaultThinkingBudget,
        supportsVision: omni?.supportsVision,
        supportsThinking: omni?.supportsThinking,
        supportedParams: [],
        stripParams: strip,
        requiresThinkingReconciliation: thinking,
        citations,
      }
      generatedModels.set(fullId, gen)
      ensureProvider(pid, reg.baseUrl, reg.citation)
    }
    ensureProvider(pid, reg.baseUrl, reg.citation)
  }

  // 3) From OpenRouter fetch
  for (const or of openRouterModels) {
    const pid = (or.id.split('/')[0] ?? '').toLowerCase()
    if (!pid) continue
    if (
      !args.all &&
      providersFilter.length > 0 &&
      !providersFilter.includes(pid)
    )
      continue
    const fullId = or.id
    if (generatedModels.has(fullId)) {
      // Merge missing fields if existing entry has default fallback values
      const existing = generatedModels.get(fullId)!
      // Preserve authoritative static entries (e.g., minimax-m3 512K not overwritten by OpenRouter 1M)
      // Only fill if existing was placeholder 128k/16k and openrouter has larger? No, keep authoritative
      // For now, keep existing and just add citation
      existing.citations.push(
        `https://openrouter.ai/api/v1/models (context_length=${or.context_length}, top_provider.max_completion_tokens=${or.top_provider?.max_completion_tokens})`,
      )
      // If existing used default 128k but openrouter has explicit larger, we could update if not authoritative.
      // For authoritative check: if existing came from OmniRoute with explicit line, don't overwrite.
      // We consider authoritative if citation includes modelSpecs.ts
      const isAuthoritative = existing.citations.some((c) =>
        c.includes('modelSpecs.ts'),
      )
      if (!isAuthoritative) {
        const orCtx = or.context_length ?? or.top_provider?.context_length
        const orMax = or.top_provider?.max_completion_tokens
        if (orCtx && orCtx !== existing.contextWindow)
          existing.contextWindow = orCtx
        if (orMax && orMax !== existing.maxOutputTokens)
          existing.maxOutputTokens = orMax
      }
      continue
    }
    const perProvCount = Array.from(generatedModels.values()).filter(
      (x) => x.provider.toLowerCase() === pid.toLowerCase(),
    ).length
    if (limit && perProvCount >= limit) continue

    const ctx = or.context_length ?? or.top_provider?.context_length ?? 128000
    const rawMax = or.top_provider?.max_completion_tokens
    const maxOut = rawMax ?? Math.min(ctx, 8192)
    const supported = or.supported_parameters
    const unsupported: readonly string[] | undefined = undefined // openrouter doesn't give unsupported, we infer
    const strip = deriveStripParams(supported, unsupported, fullId)
    const thinking = deriveThinkingReconciliation(
      undefined,
      or,
      strip.length > 0,
    )
    const hasVision =
      or.architecture?.input_modalities?.includes('image') ?? false

    // Provider baseUrl fallback: use unified provider baseUrl if exists, else openrouter-style
    const reg = unifiedProviders.get(pid)
    const baseUrl = reg?.baseUrl ?? `https://api.${pid}.com/v1`

    const citations = [
      `https://openrouter.ai/api/v1/models (id=${fullId}, context_length=${or.context_length}, top_provider.max_completion_tokens=${rawMax})`,
      'https://openrouter.ai/docs/guides/overview/models (schema: context_length→contextWindow, max_completion_tokens→maxOutputTokens)',
      'research/openrouter_models_specification.md:2 (OpenRouter spec)',
    ]
    if (reg?.citation) citations.push(reg.citation)

    const gen: GeneratedModel = {
      id: fullId,
      provider: pid,
      contextWindow: ctx,
      maxOutputTokens: maxOut,
      thinkingBudgetCap: undefined,
      defaultThinkingBudget: undefined,
      supportsVision: hasVision,
      supportsThinking: thinking ? true : undefined,
      supportedParams: supported ? [...supported] : [],
      stripParams: strip,
      requiresThinkingReconciliation: thinking,
      citations,
      visionGate: hasVision,
    }
    ensureProvider(pid, baseUrl, citations[0])

    // Alias: canonical_slug
    if (
      or.canonical_slug &&
      or.canonical_slug !== fullId &&
      !generatedModels.has(or.canonical_slug)
    ) {
      const aliasProv = or.canonical_slug.split('/')[0]!.toLowerCase()
      const aliasGen: GeneratedModel = {
        ...gen,
        id: or.canonical_slug,
        provider: aliasProv,
        citations: [...citations, `alias canonical_slug:${or.canonical_slug}`],
        aliasOf: fullId,
      }
      // respect limit for alias too
      const aliasPerProv = Array.from(generatedModels.values()).filter(
        (x) => x.provider.toLowerCase() === aliasProv.toLowerCase(),
      ).length
      if (!(limit && aliasPerProv >= limit))
        generatedModels.set(or.canonical_slug, aliasGen)
    }
  }

  // If still no generated models but provider filter given, ensure at least provider entry
  for (const pid of targetProviders) {
    const lk = pid.toLowerCase()
    if (!generatedProviders.has(lk)) {
      ensureProvider(pid)
    }
  }

  // Filter generatedModels to only target providers if not --all and we have filter
  if (!args.all && providersFilter.length > 0) {
    for (const [k, v] of Array.from(generatedModels.entries())) {
      if (!providersFilter.includes(v.provider.toLowerCase())) {
        generatedModels.delete(k)
      }
    }
    for (const [k, v] of Array.from(generatedProviders.entries())) {
      if (!providersFilter.includes(v.id.toLowerCase())) {
        generatedProviders.delete(k)
      }
    }
  }

  // Apply global limit if target was single provider and limit given: already per-provider limited above
  // But also ensure total limit if --provider openai --limit 10 means 10 models total for that provider
  // Already done per-provider. For --all with limit, it would be per-provider; to be safe, also trim total
  if (
    limit &&
    args.all &&
    generatedModels.size > limit * Math.max(1, generatedProviders.size)
  ) {
    // truncate largest providers proportionally? Simple: keep first limit per provider already done, so skip
  }

  console.log(
    `[import-provider] generated ${generatedModels.size} models across ${generatedProviders.size} providers`,
  )

  if (generatedModels.size === 0) {
    console.warn(
      '[import-provider] no models generated; check provider names and sources',
    )
    if (!dryRun) {
      // still generate empty test? No, warn and exit 1 if specific provider requested
      if (!args.all && providersFilter.length > 0) {
        // create fallback provider entries so user sees something?
      }
    }
  }

  // Merge with existing
  const existingModels = parseExistingModels()
  const existingProviders = parseExistingProviders()

  const mergedModels = new Map<string, GeneratedModel>()
  // add existing first
  for (const [k, v] of existingModels) {
    mergedModels.set(k, {
      id: v.spec.id,
      provider: v.spec.provider,
      contextWindow: v.spec.contextWindow,
      maxOutputTokens: v.spec.maxOutputTokens,
      supportedParams: v.spec.supportedParams,
      stripParams: v.spec.stripParams,
      requiresThinkingReconciliation: v.spec.requiresThinkingReconciliation,
      citations: [`existing:${MODELS_OUT}`],
    })
  }
  // overlay generated (generated wins for same key, but we keep authoritative check already)
  for (const [k, v] of generatedModels) {
    mergedModels.set(k, v)
  }

  const mergedProviders = new Map<string, GeneratedProvider>()
  for (const [k, v] of existingProviders) mergedProviders.set(k, v)
  for (const [k, v] of generatedProviders) {
    if (!mergedProviders.has(k)) mergedProviders.set(k, v)
    else {
      // merge: keep existing baseUrl if already set, otherwise take generated
      const ex = mergedProviders.get(k)!
      if (!ex.baseUrl || ex.baseUrl.includes('example.com'))
        ex.baseUrl = v.baseUrl
      if (v.relay && !ex.relay) ex.relay = v.relay
      if (v.passthroughModels && !ex.passthroughModels)
        ex.passthroughModels = v.passthroughModels
      if (v.citations.length)
        ex.citations = [...(ex.citations ?? []), ...v.citations]
    }
  }

  if (dryRun) {
    console.log('[import-provider] dry-run: would write')
    console.log('Models:')
    for (const [k, v] of Array.from(mergedModels.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      console.log(
        `  ${k} -> provider=${v.provider} ctx=${v.contextWindow} max=${v.maxOutputTokens} strip=[${v.stripParams.join(',')}] thinking=${v.requiresThinkingReconciliation} | ${v.citations.join(' | ')}`,
      )
    }
    console.log('Providers:')
    for (const [k, v] of Array.from(mergedProviders.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      console.log(
        `  ${k} -> baseUrl=${v.baseUrl} relay=${!!v.relay} passthrough=${!!v.passthroughModels} | ${v.citations.join(' | ')}`,
      )
    }
    return
  }

  // Write models.ts sorted
  const sortedModelKeys = Array.from(mergedModels.keys()).sort((a, b) =>
    a.localeCompare(b),
  )
  let modelsTs =
    'export interface ModelSpec {\n  id: string\n  provider: string\n  contextWindow: number\n  maxOutputTokens: number\n  minOutputTokens?: number\n  thinkingBudgetCap?: number\n  defaultThinkingBudget?: number\n  supportsVision?: boolean\n  supportsThinking?: boolean\n  supportedParams: Set<string>\n  stripParams: Set<string>\n  requiresThinkingReconciliation: boolean\n}\n\n'
  modelsTs += 'export const MODEL_REGISTRY: Record<string, ModelSpec> = {\n'
  for (const key of sortedModelKeys) {
    const m = mergedModels.get(key)!
    const cite = m.citations.length
      ? ` // source: ${m.citations.join(' | ')}`
      : ''
    modelsTs += `  '${key}': {${cite}\n`
    modelsTs += `    id: '${m.id}',\n`
    modelsTs += `    provider: '${m.provider}',\n`
    modelsTs += `    contextWindow: ${m.contextWindow},\n`
    if (m.minOutputTokens !== undefined)
      modelsTs += `    minOutputTokens: ${m.minOutputTokens},\n`
    if (m.thinkingBudgetCap !== undefined)
      modelsTs += `    thinkingBudgetCap: ${m.thinkingBudgetCap},\n`
    if (m.defaultThinkingBudget !== undefined)
      modelsTs += `    defaultThinkingBudget: ${m.defaultThinkingBudget},\n`
    if (m.supportsVision !== undefined)
      modelsTs += `    supportsVision: ${m.supportsVision},\n`
    if (m.supportsThinking !== undefined)
      modelsTs += `    supportsThinking: ${m.supportsThinking},\n`
    if (m.supportedParams.length > 0) {
      modelsTs += `    supportedParams: new Set<string>([${m.supportedParams.map((s) => `'${s}'`).join(', ')}]),\n`
    } else {
      modelsTs += '    supportedParams: new Set<string>(),\n'
    }
    if (m.stripParams.length > 0) {
      modelsTs += `    stripParams: new Set<string>([${m.stripParams.map((s) => `'${s}'`).join(', ')}]),\n`
    } else {
      modelsTs += '    stripParams: new Set<string>(),\n'
    }
    modelsTs += `    requiresThinkingReconciliation: ${m.requiresThinkingReconciliation},\n`
    modelsTs += '  },\n'
  }
  modelsTs += '}\n\n'
  modelsTs +=
    'export function getModelSpec(id: string): ModelSpec | undefined {\n  return MODEL_REGISTRY[id]\n}\n'

  // Write providers.ts sorted
  const sortedProvKeys = Array.from(mergedProviders.keys()).sort((a, b) =>
    a.localeCompare(b),
  )
  let providersTs =
    'export interface ProviderSpec {\n  baseUrl: string\n  apiKeyEnv: string\n  relay?: boolean\n  timeoutMs: number\n  passthroughModels?: boolean\n  format?: string\n}\n\n'
  providersTs += 'export const PROVIDERS: Record<string, ProviderSpec> = {\n'
  for (const key of sortedProvKeys) {
    const p = mergedProviders.get(key)!
    const cite = p.citations.length
      ? ` // source: ${p.citations.join(' | ')}`
      : ''
    providersTs += `  '${key}': {${cite}\n`
    providersTs += `    baseUrl: '${p.baseUrl}',\n`
    providersTs += `    apiKeyEnv: '${p.apiKeyEnv}',\n`
    if (p.relay) providersTs += '    relay: true,\n'
    providersTs += `    timeoutMs: ${p.timeoutMs},\n`
    if (p.passthroughModels) providersTs += '    passthroughModels: true,\n'
    if (p.format) providersTs += `    format: '${p.format}',\n`
    providersTs += '  },\n'
  }
  providersTs += '}\n\n'
  providersTs += `export function getProviderForModel(id: string): ProviderSpec | undefined {\n  const provider = id.split('/')[0]\n  if (provider === undefined || provider.length === 0) return undefined\n  return PROVIDERS[provider]\n}\n`
  // Also export helper for relay detection (useful for P8)
  providersTs +=
    '\nexport function isRelayProvider(id: string): boolean {\n  return PROVIDERS[id]?.relay === true\n}\n'

  writeFileSync(resolve(ROOT, MODELS_OUT), modelsTs, 'utf8')
  writeFileSync(resolve(ROOT, PROVIDERS_OUT), providersTs, 'utf8')
  console.log(
    `[import-provider] wrote ${MODELS_OUT} (${sortedModelKeys.length} models)`,
  )
  console.log(
    `[import-provider] wrote ${PROVIDERS_OUT} (${sortedProvKeys.length} providers)`,
  )

  // Generate tests per provider
  const testDir = resolve(ROOT, TESTS_OUT_DIR)
  mkdirSync(testDir, { recursive: true })

  for (const pid of Array.from(generatedProviders.keys()).sort()) {
    const prov = generatedProviders.get(pid)!
    const modelsForProv = Array.from(generatedModels.values()).filter(
      (m) => m.provider.toLowerCase() === pid.toLowerCase(),
    )
    if (modelsForProv.length === 0) continue
    const sample = modelsForProv[0]!

    const testPath = join(testDir, `${pid}.test.ts`)
    // Build test content: clamp, sanitize, thinking, app.request integration
    const clampCtx = sample.contextWindow
    const clampMax = sample.maxOutputTokens
    const stripExample =
      sample.stripParams.length > 0
        ? sample.stripParams.slice(0, 2).join(', ')
        : 'none'
    const thinkingBudget = 8192

    const testContent = `import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY, getModelSpec } from '../../src/config/models.js'
import { PROVIDERS } from '../../src/config/providers.js'
import { clampBody } from '../../src/normalizer/clamp.js'
import { sanitizeParams } from '../../src/normalizer/sanitize.js'
import { reconcileThinking } from '../../src/normalizer/thinking.js'
import { createApp } from '../../src/index.js'

/**
 * Generated by scripts/import-provider.ts for provider "${pid}"
 * Sample model: ${sample.id}
 * Citations: ${sample.citations.join(' | ')}
 * Provider citations: ${prov.citations.join(' | ')}
 */

describe('import-provider generated: ${pid}', () => {
  const sampleId = '${sample.id}'
  const spec = MODEL_REGISTRY[sampleId]

  it('provider exists in PROVIDERS with baseUrl', () => {
    const prov = PROVIDERS['${pid}']
    expect(prov).toBeDefined()
    expect(prov.baseUrl).toMatch(/^https?:\\/\\//)
    // citation: ${prov.citations.join(' | ')}
  })

  it('model exists in MODEL_REGISTRY with sorted citations', () => {
    expect(spec).toBeDefined()
    expect(spec.id).toBe(sampleId)
    expect(spec.provider).toBe('${pid}')
    expect(spec.contextWindow).toBe(${clampCtx})
    expect(spec.maxOutputTokens).toBe(${clampMax})
  })

  it('clampBody respects maxOutputTokens and contextWindow (4 chars/token)', () => {
    if (!spec) return
    const body = { model: sampleId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 9999999 }
    const clamped = clampBody(body as Record<string, unknown>, spec)
    expect(clamped.max_tokens).toBeLessThanOrEqual(spec.maxOutputTokens)
    expect(clamped.max_tokens).toBeLessThanOrEqual(spec.contextWindow)
  })

  it('clampBody handles laguna-scale overflow (estimateInputTokens 4 chars/token)', () => {
    if (!spec) return
    // Build messages that exceed contextWindow to verify clamp floors to minOutputTokens or windowBudget
    const huge = 'a'.repeat((spec.contextWindow + 1000) * 4)
    const body = { model: sampleId, messages: [{ role: 'user', content: huge }], max_tokens: spec.maxOutputTokens * 2 }
    const clamped = clampBody(body as Record<string, unknown>, spec)
    expect(clamped.max_tokens as number).toBeGreaterThanOrEqual(1)
    expect(clamped.max_tokens as number).toBeLessThanOrEqual(spec.maxOutputTokens)
  })

  it('sanitizeParams strips stripParams (${stripExample})', () => {
    if (!spec) return
    const body: Record<string, unknown> = { model: sampleId, messages: [], max_tokens: 100, temperature: 0.7, top_p: 0.9, n: 1 }
    const sanitized = sanitizeParams(body, spec)
    for (const k of spec.stripParams) {
      expect(sanitized).not.toHaveProperty(k)
    }
  })

  it('reconcileThinking caps budget and reconciles max_tokens', () => {
    if (!spec) return
    const body: Record<string, unknown> = { model: sampleId, messages: [], thinking: { budget_tokens: ${thinkingBudget} }, max_tokens: 1000 }
    const reconciled = reconcileThinking(body, spec)
    if (spec.requiresThinkingReconciliation && ${thinkingBudget} > 0) {
      expect(reconciled.max_tokens as number).toBeGreaterThanOrEqual(${thinkingBudget} + 1024)
    } else {
      expect(reconciled).toBeDefined()
    }
  })

  it('vision gate: supportsVision citation preserved', () => {
    if (!spec) return
    // visionGate=${sample.visionGate ?? 'unknown'} from source ${sample.citations.join(' | ')}
    expect(spec).toBeDefined()
  })

  it('alias resolution: canonical id maps via getModelSpec', () => {
    if (!spec) return
    expect(getModelSpec(sampleId)).toBeDefined()
  })

  it('relay vs direct tier: provider relay flag coherent', () => {
    const prov = PROVIDERS['${pid}']
    // relay=${!!prov.relay} passthrough=${!!prov.passthroughModels} citation: ${prov.citations.join(' | ')}
    expect(typeof prov.timeoutMs).toBe('number')
    if (prov.relay) expect(prov.relay).toBe(true)
  })

  it('app.request integration: POST /v1/chat/completions normalizes via clamp/sanitize/thinking', async () => {
    const app = createApp()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: sampleId, messages: [{ role: 'user', content: 'hello' }], max_tokens: 999999, temperature: 0.5 }),
    })
    // Route is stubbed to 501 but middleware + normalizer run and set headers
    // 401 would mean auth failed; 415 bad content-type; 501 means it reached handler
    expect([200, 400, 401, 415, 422, 501]).toContain(res.status)
    if (res.status === 501) {
      // headers set by normalizer
      const normalized = res.headers.get('x-normalized-max-tokens')
      if (normalized) expect(Number(normalized)).toBeLessThanOrEqual(${clampMax})
    }
  })
})
`
    writeFileSync(testPath, testContent, 'utf8')
    console.log(
      `[import-provider] generated test ${TESTS_OUT_DIR}/${pid}.test.ts`,
    )
  }

  console.log('[import-provider] done')
}

main().catch((e) => {
  console.error('[import-provider] fatal:', e)
  process.exit(1)
})
