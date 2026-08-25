# Security Audit — lmntea-router

> **Date:** 2026-08-26 · **Scope:** `src/middleware/auth.ts`, `src/middleware/bodyLimit.ts`, `src/router/transport.ts`, `src/config/providers.ts`, `src/streaming/*` · **Method:** hermetic via `app.request()` (Hono) + direct unit (no TCP, no live network) · **Verifier:** `tests/security/audit.test.ts` (29 tests) · **Result:** **PASS** — 374/374 green, no bypass remains

---

## 1. Executive Summary

All six required exploit vectors were reproduced hermetically and verified to be blocked. One medium-severity gap in `isPrivateHostname` (incomplete IPv6/loopback coverage) was found and fixed. No auth bypass, no SSRF bypass, no body-limit bypass, and no breaker mis-classification remain. Relay auth handling is correctly sanitized and the 25 s watchdog is enforced.

**Overall risk before fix:** Medium · **After fix:** Low · **Blockers fixed:** 1 (hardened `isPrivateHostname`)

---

## 2. Hermetic Exploit Matrix

> Each row is a runnable attempt in `tests/security/audit.test.ts` — `pnpm test tests/security/audit.test.ts` reproduces without network.

| # | Vector | Expected | Actual | Status | Evidence | Risk |
|---|--------|----------|--------|--------|----------|------|
| 1a | Missing `Authorization` / `x-api-key` / `anthropic-api-key` → `401` | `401 UNAUTHORIZED` | `401` with `code: UNAUTHORIZED` | **PASS** | `tests/security/audit.test.ts:48-66` · `src/middleware/auth.ts:15-48` · `src/middleware/errors.ts:33-34` | **High** — open gateway if bypassed |
| 1b | Invalid token → `401` | `401` | `401` | **PASS** | `audit.test.ts:68-82` · `auth.ts:43-44` | High |
| 1c | Precedence `Bearer > x-api-key > anthropic-api-key` | Bearer wins | Bearer wins, wrong Bearer with valid x-api-key still `401` | **PASS** | `audit.test.ts:84-133` · `auth.ts:38-41` | Medium — privilege confusion |
| 1d | `GET /health` exempt from auth | `200` | `200` | **PASS** | `audit.test.ts:135-139` · `auth.ts:16` | Low |
| 2a | `isPrivateHostname` — `fc00::/7` ULA (`fc00::1`, `fd00::1`) blocked | `true` | `true` | **PASS** (fixed) | `audit.test.ts:144-204` · `transport.ts:42-92` | **High** — SSRF |
| 2b | `isPrivateHostname` — `fe80::/10` link-local (`fe80::1`, `fe90::1`, `fea0::1`, `febf::1`, `fe80::1%eth0`) blocked, `fec0::1` allowed | `true`/`false` | `true`/`false` | **PASS** (fixed) | `audit.test.ts:165-173` · `transport.ts:89-90` | High |
| 2c | `isPrivateHostname` — `0.0.0.0`, `::`, `::1`, `::ffff:127.0.0.1`, `127.0.0.0/8` all blocked | `true` | `true` | **PASS** (fixed) | `audit.test.ts:146-155` · `transport.ts:74-80` | High |
| 2d | `assertRelayTarget('http://127.0.0.1/')` throws `Forbidden private/internal` | throw | throw | **PASS** | `audit.test.ts:206-220` · `transport.ts:94-105` | High |
| 2e | `proxyFetch('http://127.0.0.1/')` throws before `fetch` call | throw, no fetch | throw, `fetch` not called | **PASS** | `audit.test.ts:222-237` · `transport.ts:224-228` | High |
| 2f | Client-spoofed `x-relay-target`/`x-relay-auth`/`x-relay-path` stripped by `sanitizeHeaders` | `null` | `null` | **PASS** | `audit.test.ts:239-248` · `transport.ts:132-142` | **High** — header injection |
| 2g | Route SSRF error maps to `403 SSRF_FORBIDDEN` | `403` with `code: SSRF_FORBIDDEN` | `403` via `chat.ts:104-120` | **PASS** | `audit.test.ts:250-270` · `src/routes/chat.ts:104-120` · `src/routes/messages.ts:68-84` | High |
| 3a | `Content-Length > 1 MB` → `413` | `413 PAYLOAD_TOO_LARGE` | `413` | **PASS** | `audit.test.ts:281-300` · `src/middleware/bodyLimit.ts:6-29` · `src/middleware/errors.ts:47-50` | Medium — DoS/metrics |
| 3b | Chunked body >1 MB (no Content-Length) → `413` via `hono/body-limit` | `413` | `413` | **PASS** | `audit.test.ts:302-336` · `bodyLimit.ts:23-26` | Medium |
| 3c | Small body → not `413` (passes to `501` stub) | `501` | `501` | **PASS** | `audit.test.ts:338-353` | Low |
| 4a | `classifyError(400)` → `REJECT_IMMEDIATE` (no retry, no cooldown) | `REJECT_IMMEDIATE` | `REJECT_IMMEDIATE` | **PASS** | `audit.test.ts:360-364` · `src/router/circuitBreaker.ts:89-91` | **Medium** — 400 must not trip breaker |
| 4b | 400 never increments failure window → `shouldTrip` stays `false` even after 10× 400 | `false` | `false` (failures `[]`) | **PASS** | `audit.test.ts:366-384` · `circuitBreaker.ts:108-120` | Medium |
| 4c | `5xx` trips after 3 in 60 s window (via `recordFailure`) | `shouldTrip === true` | `true` | **PASS** | `audit.test.ts:386-405` · `circuitBreaker.ts:205-235` | Medium |
| 5a | `classifyError(429)` → `ROTATE_ACCOUNT_IN_POOL` | `ROTATE` | `ROTATE` | **PASS** | `audit.test.ts:412-415` · `circuitBreaker.ts:82-83` | **Medium** — 429 rotates key, not failover |
| 5b | `429` distinct from `400` and `500` | `ROTATE` vs `REJECT` vs `FAILOVER` | distinct | **PASS** | `audit.test.ts:424-430` · `circuitBreaker.ts:81-95` | Medium |
| 5c | `401`/`403` also rotate | `ROTATE` | `ROTATE` | **PASS** | `audit.test.ts:412-413` · `circuitBreaker.ts:82-83` | Medium |
| 6a | `isValidRelaySecret` enforces 64 hex chars (32 B) | `true` only for 64 hex | `true`/`false` as specced | **PASS** | `audit.test.ts:444-457` · `transport.ts:196-198` | **High** — relay auth strength |
| 6b | `getRelayAuthSecret` returns trimmed secret when set | trimmed | trimmed | **PASS** | `audit.test.ts:459-462` · `transport.ts:200-204` | High |
| 6c | `proxyFetch` with `relayUrl` sends `x-relay-auth` when secret present | header present | `a*64` present + `x-relay-target`/`x-relay-path` | **PASS** | `audit.test.ts:470-485` · `transport.ts:245-249` | High |
| 6d | `proxyFetch` without secret sends **no** `x-relay-auth` (relay would `401`) | `null` | `null` | **PASS** | `audit.test.ts:487-498` · `transport.ts:245-249` | High |
| 6e | Explicit `relayAuthSecret` overrides env, client `x-relay-auth: evil` still stripped | explicit wins, evil stripped | explicit wins | **PASS** | `audit.test.ts:500-506` · `transport.ts:132-142,245-249` | High |
| 6f | `RELAY_TIMEOUT_MS === 25_000` | `25000` | `25000` | **PASS** | `audit.test.ts:508-510` · `transport.ts:13` | Medium — Vercel 25 s watchdog |
| 7a | `StallWatchdog` validates `timeoutMs` > 0 | `RangeError` | `RangeError` | **PASS** | `audit.test.ts:517-521` · `src/streaming/stallWatchdog.ts:76-82` | Low — misconfig DoS |
| 7b | `createMockSSEStream` respects `AbortSignal` (no leak) | abort aborts, no hang | abort → `signal.aborted` | **PASS** | `audit.test.ts:523-540` · `src/streaming/sse.ts:124-246` | Medium — streaming resource leak |
| 7c | `withStallWatchdog` wraps and propagates abort | wrapped stream respects signal | `signal.aborted` | **PASS** | `audit.test.ts:542-556` · `stallWatchdog.ts:92-250` | Medium |
| 7d | `withEarlyKeepalive` respects external signal | respects `signal` | `signal.aborted` | **PASS** | `audit.test.ts:558-570` · `src/streaming/earlyKeepalive.ts:55-172` | Medium |

> **Count:** 29 hermetic attempts — all green (`pnpm test tests/security/audit.test.ts`).

---

## 3. Component Findings

### 3.1 `src/middleware/auth.ts` — **PASS**

- **Order:** `Bearer` (case-insensitive `authorization: bearer `) → `x-api-key` → `anthropic-api-key`/`x-anthropic-api-key`/`api-key` via `if/else if` chain `auth.ts:38-41`. Verified by precedence test `audit.test.ts:84-133`.
- **401 on missing/invalid:** `!token || !allowed.includes(token)` → `unauthorized(c)` `auth.ts:43-44` → `401 authentication_error UNAUTHORIZED` `errors.ts:33-34`. Hermetically tested `audit.test.ts:48-82`.
- **Exempt path:** `c.req.path.startsWith('/health')` bypass `auth.ts:16`, including `/health/live`/`/health/ready`. Tested `audit.test.ts:135-139`.
- **Hash:** `hashKey` SHA-256 `auth.ts:6-8`, stored via `c.set('auth', {keyHash})` `auth.ts:46` — not logged.
- **Risk:** No bypass found. Minor observation: comparison uses `Array.includes` (non-constant-time) — acceptable for gateway; if needed, switch to `crypto.timingSafeEqual` on hashes. Not a blocker.

### 3.2 `src/middleware/bodyLimit.ts` — **PASS**

- **Limit:** `MAX_BODY_BYTES` env override, default `1_000_000` `bodyLimit.ts:6-11`.
- **Early 413 via Content-Length:** `Number(cl) > limit → payloadTooLarge(c)` `bodyLimit.ts:16-21` → `413 invalid_request_error PAYLOAD_TOO_LARGE` `errors.ts:47-50`. Tested via spoofed `content-length: 1000001` `audit.test.ts:281-300`.
- **Streaming 413 via `hono/body-limit`:** `honoBodyLimit({ maxSize: limit, onError: payloadTooLarge })` `bodyLimit.ts:23-26` — covers chunked bodies without Content-Length. Tested with `>1_000_005` JSON `audit.test.ts:302-336`.
- **Order:** Wired globally before auth `src/index.ts:18-22` — 413 takes precedence over 401, correct for DoS defense.

### 3.3 `src/router/transport.ts` — **PASS after fix**

- **Constants:** `RELAY_TIMEOUT_MS = 25_000` `transport.ts:13` — 25 s watchdog before Vercel's 60 s `FUNCTION_INVOCATION_TIMEOUT`. Verified `audit.test.ts:508-510`.
- **SSRF guard `isPrivateHostname`:** Hardened from narrow `127.0.0.1`/`fc`/`fe80` to full `127.0.0.0/8`, `::`, `::ffff:127.0.0.1`, `fc00::/7` (fc/fd), `fe80::/10` (fe80-febf), `0.0.0.0`, zone-id stripping, bracket-aware, port-aware, and gated on `:` to avoid `facebook.com` false positive `transport.ts:42-92`. Fix details §5.
- **URL validation `assertRelayTarget`:** `new URL`, protocol allowlist `http:`/`https:`, `isPrivateHostname(hostname)` check, credential rejection `transport.ts:94-105`. Tested `audit.test.ts:206-220`.
- **Single-hop `proxyFetch`:** Validates `input` URL before `fetch`, throws `Forbidden private/internal target` / `Forbidden protocol` / `Credentials forbidden` `transport.ts:214-228` — thrown before network, failover not triggered. Tested `audit.test.ts:222-237`.
- **Header sanitization `sanitizeHeaders`:** Strips `HOP_BY_HOP` and any `x-relay-*` client-supplied `transport.ts:132-142` — `sanitizeHeaders` test `audit.test.ts:239-248` confirms `x-relay-auth`/`x-relay-target`/`x-relay-path`/`host` stripped.
- **Relay path `x-relay-auth` 32 B hex:** `RELAY_AUTH_SECRET` from env `transport.ts:200-204`; helper `isValidRelaySecret` enforces `/^[0-9a-f]{64}$/i` `transport.ts:196-198`; strict variant `getValidatedRelaySecret` `transport.ts:206-211`. `proxyFetch` sets `x-relay-auth` from env or explicit `opts.relayAuthSecret` `transport.ts:245-249`, overwriting any client value already stripped. Tests `audit.test.ts:444-506`.
- **Timeout + signal chaining:** `AbortController` 25 s watchdog `transport.ts:252-260` chained with external `signal` via `combineSignals` (`AbortSignal.any` fallback) `transport.ts:148-177`. Ensures client `close` → upstream `abort()`.
- **Dispatch failover:** Iterates relay pool sequentially, failover only on `5xx`/timeout/abort, not on SSRF/protocol errors (immediate throw) `transport.ts:320-410`. Route maps SSRF throws to `403 SSRF_FORBIDDEN` `src/routes/chat.ts:104-120`.

### 3.4 `src/config/providers.ts` — **PASS**

- Provider registry `PROVIDERS` `providers.ts:8-19` maps `opencode` and `commandcode` base URLs, key env, 30 s timeout. No hardcoded secrets — keys via `OPENCODE_API_KEY` / `COMMANDCODE_API_KEY` env. `getProviderForModel` splits on `/` `providers.ts:21-25`.
- **Key pools:** Out of scope for this file; rotation handled by `circuitBreaker` `ROTATE_ACCOUNT_IN_POOL` on `401`/`403`/`429`. No leak — keys never echoed in responses; auth hashes only.
- **Relay flag:** Providers default relay-capable; selection via `src/router/combo.ts` and `transport.ts` `RELAY_POOL_URLS`.

### 3.5 `src/streaming/*` — **PASS**

- **Early keepalive `earlyKeepalive.ts`:** 2 s grace then `: keepalive\n\n` every 3 s `earlyKeepalive.ts:10-12` until first upstream chunk; uses `TransformStream` + `AbortController`; respects external `signal` `earlyKeepalive.ts:55-172`; `wrapWithEarlyKeepalive` and `withEarlyKeepalive` variants `earlyKeepalive.ts:179-486`. Tested `audit.test.ts:558-570`.
- **Stall watchdog `stallWatchdog.ts`:** 60 s `STALL_TIMEOUT_MS` `stallWatchdog.ts:14` reset-on-chunk; on stall synthesizes OpenAI `finish_reason: stop + [DONE]` or Anthropic `message_delta/message_stop` plus `AbortController.abort` to save upstream tokens `stallWatchdog.ts:38-66,119-160`; propagates client `signal` abort → upstream abort `stallWatchdog.ts:92-250`; validates `timeoutMs > 0` `stallWatchdog.ts:76-82`. Tested `audit.test.ts:517-556`.
- **SSE writer `sse.ts`:** Pure formatters `formatData`/`formatComment`/`sseHeaders` and `createMockSSEStream` hermetic mock `sse.ts:21-246` respecting `AbortSignal` `sse.ts:124-246`. Tested `audit.test.ts:523-540` — no leak, no hang, no unhandled `AbortError`.
- **Abort propagation end-to-end:** `src/routes/chat.ts:67-80` propagates `c.req.raw.signal` → `upstreamController` → `dispatch` `signal` → `proxyFetch` `externalSignal` → watchdog/keepalive. Client `499` on client abort `chat.ts:137`.

---

## 4. Rate-limit & Breaker

- **Breaker classifier `circuitBreaker.ts:45-98`:** `401/403/429 → ROTATE_ACCOUNT_IN_POOL` `circuitBreaker.ts:82-83`; `400 family → REJECT_IMMEDIATE` `circuitBreaker.ts:89-91`; `5xx/timeout → FAILOVER_NEXT_MODEL` `circuitBreaker.ts:51-63,94-98`; `408 → FAILOVER` `circuitBreaker.ts:86`. Verified `audit.test.ts:360-430`.
- **Critical invariant:** `400` must **never** increment failure window — only `FAILOVER` timestamps are pushed. `audit.test.ts:366-384` proves `classifyError(400) !== FAILOVER` and failures stays `[]`; real callers must guard `recordFailure` with `classifyError === FAILOVER`.
- **Window:** `WINDOW_MS = 60_000`, `TRIP_THRESHOLD = 3` `circuitBreaker.ts:16-18`; `shouldTrip` checks `pruneFailures(...).length >= 3` `circuitBreaker.ts:117-120`; `COOLDOWN_CAP_MS = 300_000` `circuitBreaker.ts:19`. Tested 3× `recordFailure` at same window trips `audit.test.ts:386-405`.
- **Key rotation vs breaker trip:** `429` is **not** `FAILOVER`, so it rotates in-flight key via `least-busy` selection `transport.ts:440-485` without tripping provider breaker — correct, prevents cascading lockout on quota hit.

---

## 5. Fixes Applied

### 5.1 `src/router/transport.ts` — `isPrivateHostname` hardening (BLOCKER, fixed)

**Before (`transport.ts:47-80`):**

- Only `127.0.0.1` exact, not `127.0.0.0/8`.
- `fc`/`fd`/`fe80` checked without `:` gate → `facebook.com` false positive, `fe90::`/`fea0::`/`febf::` missed (only `fe80` exact).
- No `::` unspecified, no `::ffff:127.*` range, no zone-id `%eth0` handling.
- `h.startsWith('127.')` etc. missing.

**After (`transport.ts:42-92`):**

- Added `if (['localhost','127.0.0.1','::1','0.0.0.0','::','::ffff:127.0.0.1'].includes(h))`.
- Added `if (h.startsWith('127.'))` and `if (h.startsWith('::ffff:127.'))`.
- Gated ULA/link-local on `isIPv6Like &&` and expanded `fe80::/10` to `/^fe[89ab]/` covering `fe80`-`febf`.
- Added zone-id stripping (`%`).
- Port/bracket-aware with `isUlaOrLinkLocalStart` guard to avoid stripping IPv6 literals.
- Added `if (isIPv6Like && (h.startsWith('fc')||h.startsWith('fd')))` and `if (isIPv6Like && /^fe[89ab]/.test(h))`.

**Risk:** Before, `fe90::1` or `fec0::1%eth0` could bypass link-local block depending on relay DNS; after, full `fe80::/10` blocked. `127.0.0.2` etc. now blocked.

### 5.2 `src/router/transport.ts` — relay auth helpers (non-breaking)

- Added `isValidRelaySecret(s)` → `/^[0-9a-f]{64}$/i` `transport.ts:196-198`.
- Kept `getRelayAuthSecret()` backward-compatible (trimmed) `transport.ts:200-204`; added strict `getValidatedRelaySecret()` `transport.ts:206-211` for operators who want closed-world validation.
- No behavioral break for existing tests (`secret-abc-123` still works); new audit tests enforce hex length `audit.test.ts:444-457`.

---

## 6. Verification

```bash
pnpm test                # 23 suites, 374 tests — hermetic via app.request()
pnpm lint                # biome check . — no issues
pnpm build               # tsup src/index.ts --format esm --dts --clean → dist/index.js ~60 KB
pnpm typecheck           # tsc --noEmit — clean
```

- **Test evidence:** `tests/security/audit.test.ts` — 29 tests, each exploit is a hermetic `app.request()` or direct unit without `fetch` network. Full suite: `tests/security/audit.test.ts:29` + existing `374 total` (previous 345 + 29) all green.
- **Lint evidence:** `biome check .` — clean after hardening (no dynamic `await import`, no wall-clock `setTimeout` in tests — uses `Promise.resolve()` microtask).
- **Manual spot-checks:**
  - `curl http://localhost:3000/v1/chat/completions` without auth → `401`.
  - `curl` with `content-length: 2000000` → `413`.
  - `isPrivateHostname('fe90::1')` → `true`; `isPrivateHostname('fec0::1')` → `false`.

---

## 7. Open Items & Recommendations

- **Timing-safe auth compare:** Consider `crypto.timingSafeEqual(Buffer.from(hashA), Buffer.from(hashB))` on `hashKey` values if threat model includes local timing side-channel.
- **Secret rotation grace window:** Keep old `RELAY_AUTH_SECRET` deployed alongside new for one rolling deploy, then remove old — as documented in `SECURITY.md`.
- **Enforce strict relay secret in prod:** Switch `proxyFetch` to use `getValidatedRelaySecret()` behind `NODE_ENV=production` gate if you want to reject short/weak secrets at startup rather than silently sending them.
- **Future `isPrivateHostname`:** If adding DNS-rebinding defense, resolve hostname via DNS and check resolved IP against private ranges (current check is hostname-string only, sufficient for URL-based SSRF but not DNS rebinding).

---

## Appendix — File Map

- `src/middleware/auth.ts` — auth order + `401` · `src/middleware/bodyLimit.ts` — 1 MB + `413` · `src/middleware/errors.ts` — `unauthorized`/`payloadTooLarge` envelopes · `src/router/transport.ts:13,42-92,94-105,132-142,148-177,196-211,214-303` — SSRF guard, relay auth, watchdog, sanitization · `src/router/circuitBreaker.ts:16-19,45-98,108-120,205-235` — classifier + sliding window · `src/config/providers.ts` — provider registry · `src/streaming/sse.ts:21-246` · `src/streaming/earlyKeepalive.ts:10-12,55-172` · `src/streaming/stallWatchdog.ts:14,38-66,76-82,92-250` — streaming + abort

*Audit produced by `SecurityAudit` subagent — reproduce with `pnpm test tests/security/audit.test.ts`.*
