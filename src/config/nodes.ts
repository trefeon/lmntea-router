import { isPrivateHostname } from '../router/transport.js'

/**
 * User-defined provider node (freellmapi concept, OmniRoute provider_nodes,
 * 9router openai-compatible-* virtual prefix — see
 * docs/superpowers/specs/2026-09-04-provider-nodes-wireframe.md).
 *
 * A node is a process-local custom upstream. Its model ids live under the
 * `custom-<slug>/` prefix so builtin MODEL_REGISTRY entries always win and
 * a node can never shadow a builtin provider id or alias.
 */
export type NodeFormat = 'openai' | 'anthropic'

export interface ProviderNode {
  /** Must start with `custom-` and must not collide with a builtin provider id. */
  id: string
  /** Wire dialect — mirrors ProviderSpec.format ('openai' | 'claude'). */
  format: NodeFormat
  baseUrl: string
  /** Default path suffix appended to baseUrl per format. */
  chatPath?: string
  headers?: Record<string, string>
  /**
   * Preferred auth is `keyEnv` (no secret at rest). An inline `key` is allowed
   * for dashboard convenience — it lives in gitignored storage only and is
   * never echoed by the admin API (redacted to keySet + mask).
   */
  auth?: {
    header?: string
    scheme?: 'bearer' | 'x-api-key'
    keyEnv?: string
    key?: string
  }
  keyless?: boolean
  models?: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }>
  timeoutMs?: number
  /** Loopback opt-in — same semantics as ProviderSpec.allowPrivate. */
  allowPrivate?: boolean
  enabled?: boolean
}

/** Default chat path per wire format (ProviderSpec baseUrl conventions). */
export const NODE_CHAT_PATH: Record<NodeFormat, string> = {
  openai: '/chat/completions',
  anthropic: '/messages',
}

/**
 * Builtin provider ids/aliases are reserved for builtin candidates. Node ids
 * additionally must live under the `custom-` prefix (OmniRoute
 * buildReservedPrefixes rule: user definitions never shadow the registry).
 */
export function validateNodeId(id: string, builtinIds: ReadonlySet<string>): void {
  if (!id.startsWith('custom-')) {
    throw new Error(`node id '${id}' must start with 'custom-' (reserved prefix)`)
  }
  if (builtinIds.has(id)) {
    throw new Error(`node id '${id}' collides with a reserved builtin provider id`)
  }
}

/** SSRF gate for node baseUrls: private targets require explicit allowPrivate. */
export function validateNodeBaseUrl(node: ProviderNode): void {
  let host: string
  try {
    host = new URL(node.baseUrl).hostname
  } catch {
    throw new Error(`node '${node.id}' baseUrl is not a valid URL`)
  }
  if (isPrivateHostname(host) && node.allowPrivate !== true) {
    throw new Error(
      `node '${node.id}' baseUrl ${node.baseUrl} is a private/internal target — set allowPrivate: true to opt in`,
    )
  }
}

/** Model id exposed for requests: `custom-<slug>/<model>`. */
export function nodeModelId(node: ProviderNode, modelId: string): string {
  return `${node.id}/${modelId}`
}

/** True when the model id belongs to a node (`custom-` prefix rule). */
export function isNodeModelId(model: string): boolean {
  return model.startsWith('custom-') && model.includes('/')
}

/**
 * Process-local node store. Static MODEL_REGISTRY/PROVIDERS always win:
 * a node is only consulted after a static miss.
 */
const nodes = new Map<string, ProviderNode>()
let builtinIds: ReadonlySet<string> = new Set<string>()

export function setNodes(list: ProviderNode[], providerIds?: Iterable<string>): void {
  if (providerIds) {
    builtinIds = new Set<string>(providerIds)
  }
  nodes.clear()
  const seen = new Set<string>()
  for (const node of list) {
    validateNodeId(node.id, builtinIds)
    if (seen.has(node.id)) {
      throw new Error(`duplicate node id '${node.id}'`)
    }
    seen.add(node.id)
    validateNodeBaseUrl(node)
    nodes.set(node.id, node)
  }
}

export function getNode(id: string): ProviderNode | undefined {
  return nodes.get(id)
}

export function listNodes(): ProviderNode[] {
  return [...nodes.values()]
}

/**
 * Resolve `custom-<slug>/<model>` to its node. Returns undefined when the
 * prefix does not name a known node or the model is not declared by a node
 * that declares models (declared-model nodes are strict; model-less nodes
 * pass everything through).
 */
export function resolveNodeForModel(model: string): ProviderNode | undefined {
  if (!isNodeModelId(model)) return undefined
  const slash = model.indexOf('/')
  const nodeId = model.slice(0, slash)
  const node = nodes.get(nodeId)
  if (!node || node.enabled === false) return undefined
  if (node.models === undefined) return node
  const short = model.slice(slash + 1)
  return node.models.some((m) => m.id === short) ? node : undefined
}

export function resetNodesForTests(): void {
  nodes.clear()
  builtinIds = new Set<string>()
}
