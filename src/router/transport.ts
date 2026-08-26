/**
 * transport.ts — tiered dispatch: Vercel relay pool (25 s watchdog) + direct/VPS fallback
 *
 * Pure where possible, side effects isolated to `fetch`. Hermetic via `vi.stubGlobal('fetch', ...)`.
 * SSRF guard via `isPrivateHostname`, relay auth via `x-relay-auth`, header sanitization,
 * least-busy selection, and sibling failover (100% proxied until success or list exhausted).
 *
 * Research refs:
 *  - `research/proxy_pools_vercel_relay_audit.md` PR#9158 (25 s watchdog), PR#8324 (x-relay-auth), PR#6149 (isPrivateHostname)
 *  - `devdocs/08-SECURITY.md` §2–§3
 */

export const RELAY_TIMEOUT_MS = 25_000

export interface ProxyFetchOptions {
  relayUrl?: string
  relayAuthSecret?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DispatchOptions {
  url: string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal
  relayUrls?: string[]
  relayAuthSecret?: string
  timeoutMs?: number
  fallbackToDirect?: boolean
}

export interface RelayRequestInit extends RequestInit {
  duplex?: 'half'
}

// ---------------------------------------------------------------------------
// SSRF guard — isPrivateHostname
// ---------------------------------------------------------------------------

/**
 * Returns true if `host` is private, loopback, metadata, or ULA and must be blocked.
 * Covers: localhost, 127.0.0.0/8, ::1, 0.0.0.0, ::, ::ffff:127.0.0.1, 169.254.169.254, 10/8, 192.168/16,
 * 172.16/12, 169.254/16 link-local, fc00::/7 (fc/fd), fe80::/10 (fe80-febf). Case-insensitive, bracket-aware,
 * zone-id aware (%eth0), and port-aware for host:port forms. Only IPv6 literals (contains ':') are
 * checked against fc/fd/fe80 ranges to avoid false positives on hostnames like facebook.com.
 */
export function isPrivateHostname(host: string): boolean {
  if (!host) return true
  const raw = host.toLowerCase().trim()
  let withoutBrackets = raw
  if (raw.startsWith('[') && raw.includes(']')) {
    const end = raw.indexOf(']')
    withoutBrackets = raw.slice(1, end)
  }
  // strip IPv6 zone identifier (e.g., fe80::1%eth0)
  const pct = withoutBrackets.indexOf('%')
  if (pct !== -1) withoutBrackets = withoutBrackets.slice(0, pct)

  let h = withoutBrackets
  const hasDoubleColon = withoutBrackets.includes('::')
  let isIPv6Like = withoutBrackets.includes(':')
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d or canonical hex ::ffff:aabb:ccdd)
  // back to dotted IPv4 so every RFC1918/loopback/link-local check below applies.
  // WHATWG URL canonicalizes http://[::ffff:169.254.169.254]/ to ::ffff:a9fe:a9fe.
  const mappedPrefix = '::ffff:'
  if (h.startsWith(mappedPrefix)) {
    const tail = h.slice(mappedPrefix.length)
    const hexParts = tail.split(':')
    if (hexParts.length === 2 && !tail.includes('.')) {
      const hi = Number.parseInt(hexParts[0] ?? '', 16)
      const lo = Number.parseInt(hexParts[1] ?? '', 16)
      if (
        Number.isFinite(hi) &&
        Number.isFinite(lo) &&
        hi >= 0 &&
        hi <= 0xffff &&
        lo >= 0 &&
        lo <= 0xffff
      ) {
        h = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
        isIPv6Like = false
      }
    } else if (hexParts.length === 1 && tail.includes('.')) {
      h = tail
      isIPv6Like = false
    }
  }
  const isUlaOrLinkLocalStart =
    withoutBrackets.startsWith('fc') ||
    withoutBrackets.startsWith('fd') ||
    /^fe[89ab]/.test(withoutBrackets)
  if (
    withoutBrackets.includes(':') &&
    !hasDoubleColon &&
    !isUlaOrLinkLocalStart
  ) {
    const lastColon = withoutBrackets.lastIndexOf(':')
    const candidate = withoutBrackets.slice(0, lastColon)
    if (candidate.includes('.') || candidate === 'localhost') h = candidate
  }

  if (
    [
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0',
      '::',
      '::ffff:127.0.0.1',
    ].includes(h)
  )
    return true
  // 127.0.0.0/8 — all loopback
  if (h.startsWith('127.')) return true
  if (h.startsWith('::ffff:127.')) return true
  if (h === '169.254.169.254') return true
  if (h.startsWith('10.')) return true
  if (h.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true
  if (h.startsWith('169.254.')) return true
  if (h.startsWith('0.')) return true
  // fc00::/7 — ULA (fc00:: - fdff::), only for IPv6 literals to avoid hostname false positives
  if (isIPv6Like && (h.startsWith('fc') || h.startsWith('fd'))) return true
  // fe80::/10 — link-local (fe80:: - febf::), only for IPv6 literals
  if (isIPv6Like && /^fe[89ab]/.test(h)) return true
  return false
}

export function assertRelayTarget(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('Invalid x-relay-target')
  }
  if (!['http:', 'https:'].includes(u.protocol))
    throw new Error('Forbidden protocol')
  if (isPrivateHostname(u.hostname))
    throw new Error('Forbidden private/internal target')
  if (u.username || u.password) throw new Error('Credentials in URL forbidden')
  return u
}

// ---------------------------------------------------------------------------
// Header sanitization
// ---------------------------------------------------------------------------

const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  'keep-alive': true,
  'proxy-connection': true,
  'transfer-encoding': true,
  te: true,
  trailer: true,
  upgrade: true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  host: true,
  'content-length': true,
}

/**
 * Sanitize headers before forwarding upstream/relay.
 * Strips hop-by-hop and any client-supplied `x-relay-*` to prevent spoofing.
 */
export function sanitizeHeaders(input?: HeadersInit): Headers {
  const out = new Headers()
  if (!input) return out
  const src = input instanceof Headers ? input : new Headers(input)
  src.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP[lk] === true) return
    if (lk.startsWith('x-relay-')) return
    out.set(k, v)
  })
  return out
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

function combineSignals(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s !== undefined)
  if (valid.length === 0) return undefined
  if (valid.length === 1) return valid[0]
  const abortSignalWithAny = AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal
  }
  const anyFn = abortSignalWithAny.any
  if (typeof anyFn === 'function') return anyFn(valid)
  const controller = new AbortController()
  for (const s of valid) {
    if (s.aborted) {
      const reasonHolder = s as unknown as { reason?: unknown }
      controller.abort(reasonHolder.reason)
      break
    }
    const sig = s
    sig.addEventListener(
      'abort',
      () => {
        const holder = sig as unknown as { reason?: unknown }
        controller.abort(holder.reason)
      },
      { once: true },
    )
  }
  return controller.signal
}

// ---------------------------------------------------------------------------
// Relay pool helpers
// ---------------------------------------------------------------------------

export function getDefaultRelayPool(): string[] {
  const raw =
    process.env.RELAY_POOL_URLS ??
    process.env.RELAY_POOL ??
    process.env.VERCEL_RELAY_URL ??
    process.env.RELAY_URL ??
    ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isValidRelaySecret(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s)
}

export function getRelayAuthSecret(): string | undefined {
  const s = process.env.RELAY_AUTH_SECRET
  if (s && s.trim().length > 0) return s.trim()
  return undefined
}

/** Strict variant — returns secret only if it is valid 32-byte hex (64 hex chars). */
export function getValidatedRelaySecret(): string | undefined {
  const s = getRelayAuthSecret()
  if (s && isValidRelaySecret(s)) return s
  return undefined
}

// ---------------------------------------------------------------------------
// proxyFetch — single hop with 25 s watchdog + SSRF guard + x-relay-auth
// ---------------------------------------------------------------------------

/**
 * Fetch `input` either directly or via `relayUrl`.
 * - Validates URL protocol + SSRF guard on the *target* host.
 * - When `relayUrl` is set, forwards as `fetch(relayUrl, { headers: { x-relay-target, x-relay-path, x-relay-auth } })`
 *   with a 25 s abort watchdog. Headers are sanitized; hop-by-hop and client `x-relay-*` are stripped.
 * - `signal` is chained with the watchdog via `AbortSignal.any` (or manual fallback).
 */
export async function proxyFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: ProxyFetchOptions = {},
): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input.toString()
  let target: URL
  try {
    target = new URL(urlStr)
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`)
  }
  if (!['http:', 'https:'].includes(target.protocol))
    throw new Error(`Forbidden protocol: ${target.protocol}`)
  if (isPrivateHostname(target.hostname))
    throw new Error(`Forbidden private/internal target: ${target.hostname}`)
  if (target.username || target.password)
    throw new Error('Credentials in URL forbidden')

  const externalSignal = opts.signal ?? (init.signal as AbortSignal | undefined)
  const timeoutMs = opts.timeoutMs ?? RELAY_TIMEOUT_MS

  // Relayed path
  if (opts.relayUrl) {
    let relay: URL
    try {
      relay = new URL(opts.relayUrl)
    } catch {
      throw new Error(`Invalid relay URL: ${opts.relayUrl}`)
    }
    if (!['http:', 'https:'].includes(relay.protocol))
      throw new Error(`Forbidden relay protocol: ${relay.protocol}`)

    const headers = sanitizeHeaders(init.headers)
    const relayAuth = opts.relayAuthSecret ?? getRelayAuthSecret()
    if (relayAuth) headers.set('x-relay-auth', relayAuth)
    headers.set('x-relay-target', `${target.protocol}//${target.host}`)
    headers.set('x-relay-path', `${target.pathname}${target.search}`)

    const timeoutController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== 0) {
      timeoutId = setTimeout(() => {
        timeoutController.abort(
          new DOMException(`Relay timeout after ${timeoutMs}ms`, 'AbortError'),
        )
      }, timeoutMs)
    }
    const signal = combineSignals([externalSignal, timeoutController.signal])

    const relayInit: RelayRequestInit = {
      method: init.method ?? 'GET',
      headers,
      keepalive: true,
    }
    if (signal !== undefined) relayInit.signal = signal
    if (init.body !== undefined) relayInit.body = init.body as BodyInit | null
    if (init.body) relayInit.duplex = 'half'

    try {
      const res = await fetch(relay.toString(), relayInit)
      clearTimeout(timeoutId)
      return res
    } catch (e) {
      clearTimeout(timeoutId)
      throw e
    }
  }

  // Direct path
  const headers = sanitizeHeaders(init.headers)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let signal: AbortSignal | undefined = externalSignal
  let timeoutController: AbortController | undefined
  if (timeoutMs !== 0) {
    const controller = new AbortController()
    timeoutController = controller
    timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(`Fetch timeout after ${timeoutMs}ms`, 'AbortError'),
      )
    }, timeoutMs)
    signal = combineSignals([externalSignal, controller.signal])
  }

  const directInit: RelayRequestInit = {
    method: init.method ?? 'GET',
    headers,
    keepalive: true,
  }
  if (signal !== undefined) directInit.signal = signal
  if (init.body !== undefined) directInit.body = init.body as BodyInit | null
  if (init.body) directInit.duplex = 'half'

  try {
    const res = await fetch(urlStr, directInit)
    clearTimeout(timeoutId)
    return res
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

// ---------------------------------------------------------------------------
// dispatch — relay pool + direct/VPS fallback (sibling failover)
// ---------------------------------------------------------------------------

/**
 * Dispatch `opts.url` through the relay pool with failover.
 * - Iterates `relayUrls` (or env `RELAY_POOL_URLS`) sequentially. On `5xx` or timeout/abort, tries next relay.
 * - SSRF / protocol errors throw immediately (no failover).
 * - If all relays fail or pool is empty and `fallbackToDirect` is true, tries a direct `proxyFetch` (no relay).
 * - 100% proxied until success: direct is only used when every relay has been exhausted or pool is empty.
 */
export async function dispatch(opts: DispatchOptions): Promise<Response> {
  const relayUrls = (opts.relayUrls ?? getDefaultRelayPool())
    .map((s) => s.trim())
    .filter(Boolean)
  const relayAuth = opts.relayAuthSecret ?? getRelayAuthSecret()
  const timeoutMs = opts.timeoutMs ?? RELAY_TIMEOUT_MS
  const fallbackToDirect = opts.fallbackToDirect ?? true

  let lastError: unknown = null

  for (const relayUrl of relayUrls) {
    try {
      const proxyInit: RequestInit = {}
      if (opts.method !== undefined) proxyInit.method = opts.method
      if (opts.headers !== undefined) proxyInit.headers = opts.headers
      if (opts.body !== undefined) proxyInit.body = opts.body
      if (opts.signal !== undefined) proxyInit.signal = opts.signal
      const proxyOpts: ProxyFetchOptions = { relayUrl, timeoutMs }
      if (relayAuth !== undefined) proxyOpts.relayAuthSecret = relayAuth
      if (opts.signal !== undefined) proxyOpts.signal = opts.signal
      const res = await proxyFetch(opts.url, proxyInit, proxyOpts)
      if (res.status >= 500 && res.status <= 599) {
        lastError = new Error(`Relay ${relayUrl} returned ${res.status}`)
        continue
      }
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        msg.includes('Forbidden private') ||
        msg.includes('private/internal target') ||
        msg.includes('Forbidden protocol') ||
        msg.includes('Credentials in URL')
      ) {
        throw e
      }
      if (opts.signal?.aborted) throw e
      if (
        e instanceof DOMException &&
        e.name === 'AbortError' &&
        opts.signal?.aborted
      )
        throw e
      lastError = e
    }
  }

  if (fallbackToDirect) {
    try {
      const directInit2: RequestInit = {}
      if (opts.method !== undefined) directInit2.method = opts.method
      if (opts.headers !== undefined) directInit2.headers = opts.headers
      if (opts.body !== undefined) directInit2.body = opts.body
      if (opts.signal !== undefined) directInit2.signal = opts.signal
      const directOpts: ProxyFetchOptions = { timeoutMs }
      if (opts.signal !== undefined) directOpts.signal = opts.signal
      const directRes = await proxyFetch(opts.url, directInit2, directOpts)
      if (
        directRes.status >= 500 &&
        directRes.status <= 599 &&
        relayUrls.length > 0
      ) {
        lastError = new Error(`Direct returned ${directRes.status}`)
        throw lastError
      }
      return directRes
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        msg.includes('Forbidden private') ||
        msg.includes('private/internal target') ||
        msg.includes('Forbidden protocol') ||
        msg.includes('Credentials in URL')
      ) {
        throw e
      }
      lastError = e
      throw e
    }
  }

  throw lastError ?? new Error('No relay/direct available')
}

// ---------------------------------------------------------------------------
// least-busy selection — pure, no I/O
// ---------------------------------------------------------------------------

function getLoadValue(item: unknown): number {
  if (item !== null && typeof item === 'object') {
    const rec = item as Record<string, unknown>
    if ('inFlight' in item) {
      const v = rec.inFlight
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    if ('in_flight' in item) {
      const v = rec.in_flight
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    if ('load' in item) {
      const v = rec.load
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    if ('connections' in item) {
      const v = rec.connections
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
  }
  return 0
}

/**
 * Pick the item with the lowest load. `getLoad` defaults to `item.inFlight` / `item.load` / 0.
 * Pure — does not mutate.
 */
export function pickLeastBusy<T>(
  items: T[],
  getLoad?: (item: T) => number,
): T | undefined {
  if (items.length === 0) return undefined
  const loadOf = (item: T): number => {
    if (getLoad) return getLoad(item)
    return getLoadValue(item)
  }
  let best = items[0] as T
  let bestLoad = loadOf(best)
  for (let i = 1; i < items.length; i++) {
    const cur = items[i] as T
    const curLoad = loadOf(cur)
    if (curLoad < bestLoad) {
      best = cur
      bestLoad = curLoad
    }
  }
  return best
}

/**
 * Select the least-busy key from a list using a load map/record.
 * Pure helper for account pool `Map<key, inFlight>`.
 */
export function selectLeastBusyKey(
  keys: string[],
  loads: Map<string, number> | Record<string, number>,
): string | undefined {
  if (keys.length === 0) return undefined
  const recordLoads = loads as Record<string, number>
  const get = (k: string): number => {
    if (loads instanceof Map) return loads.get(k) ?? 0
    return recordLoads[k] ?? 0
  }
  let best = keys[0] as string
  let bestLoad = get(best)
  for (const k of keys.slice(1)) {
    const curLoad = get(k)
    if (curLoad < bestLoad) {
      best = k
      bestLoad = curLoad
    }
  }
  return best
}

/**
 * Alias for backwards compat / docs — `least-busy key selection`.
 */
export const getLeastBusyAccount = pickLeastBusy

export default dispatch
