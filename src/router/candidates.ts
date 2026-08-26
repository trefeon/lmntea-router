/**
 * Shared upstream-candidate resolution for /v1/chat/completions and
 * /v1/messages — single source of truth (was duplicated byte-identical in
 * both routes; deduped after allowPrivate threading nearly missed one site).
 */
import { MODEL_REGISTRY, getModelSpec } from '../config/models.js'
import { PROVIDERS, getProviderForModel } from '../config/providers.js'
import type { BreakerState } from './circuitBreaker.js'
import { routeCombo } from './combo.js'

export interface UpstreamCandidate {
  provider: string
  url: string
  allowPrivate?: boolean
}

export function primaryProviderFor(model: string): string {
  const prefix = model.split('/')[0] ?? ''
  if (prefix.length > 0 && PROVIDERS[prefix] !== undefined) return prefix
  const spec = getModelSpec(model)
  return spec?.provider ?? 'unknown'
}

function providerUrl(provider: string, pathSuffix: string): string | null {
  const spec = PROVIDERS[provider]
  if (!spec) return null
  return `${spec.baseUrl.replace(/\/$/, '')}${pathSuffix}`
}

/**
 * Other registered providers hosting the same model slug with a wire format
 * compatible with this route (fallback/priority candidates from PROVIDERS).
 */
function alternateProvidersFor(
  model: string,
  wireFormat: 'openai' | 'claude',
): string[] {
  const slash = model.indexOf('/')
  const slug = slash > 0 ? model.slice(slash + 1) : ''
  if (slug.length === 0) return []
  const exclude = primaryProviderFor(model)
  const out: string[] = []
  for (const id of Object.keys(MODEL_REGISTRY)) {
    const cut = id.indexOf('/')
    if (cut <= 0 || id.slice(cut + 1) !== slug) continue
    const name = id.slice(0, cut)
    if (
      name === exclude ||
      out.includes(name) ||
      PROVIDERS[name] === undefined
    ) {
      continue
    }
    const fmt = PROVIDERS[name]?.format
    const compatible =
      wireFormat === 'openai'
        ? fmt === undefined || fmt === 'openai'
        : fmt === 'claude'
    if (!compatible) continue
    out.push(name)
  }
  return out
}

/**
 * Ordered upstream candidates for a model: primary provider first, then any
 * compatible alternate providers. When more than one candidate exists the
 * combo router orders them (fallback strategy, healthy-first via live breaker
 * states). Single-provider models keep a one-element list.
 *
 * `breakerState` is the route's live per-provider circuit-breaker map.
 */
export function buildUpstreamCandidates(
  model: string,
  pathSuffix: string,
  wireFormat: 'openai' | 'claude',
  opts: { breakerState: Map<string, BreakerState> },
): UpstreamCandidate[] {
  const primaryName = primaryProviderFor(model)
  const primarySpec = getProviderForModel(model)
  const primaryBase = (
    primarySpec?.baseUrl ?? 'https://opencode.ai/zen/v1'
  ).replace(/\/$/, '')
  const primaryUrl = `${primaryBase}${pathSuffix}`
  const alts = alternateProvidersFor(model, wireFormat)
  if (alts.length === 0) {
    return [
      {
        provider: primaryName,
        url: primaryUrl,
        allowPrivate: PROVIDERS[primaryName]?.allowPrivate === true,
      },
    ]
  }
  const ordered = routeCombo(
    [primaryName, ...alts].map((name) => ({ model: name })),
    { strategy: 'fallback', breakerState: opts.breakerState },
  )
  const names = ordered.map((cand) => cand.model)
  if (!names.includes(primaryName)) names.unshift(primaryName)
  const candidates: UpstreamCandidate[] = []
  for (const name of names) {
    const url =
      name === primaryName ? primaryUrl : providerUrl(name, pathSuffix)
    if (url)
      candidates.push({
        provider: name,
        url,
        allowPrivate: PROVIDERS[name]?.allowPrivate === true,
      })
  }
  return candidates.length > 0
    ? candidates
    : [{ provider: primaryName, url: primaryUrl }]
}

export function routerActionHeaders(actions: string[]): Record<string, string> {
  return actions.length > 0 ? { 'x-router-action': actions.join(',') } : {}
}
