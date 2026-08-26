# AGENTS.md — lmntea-router harness guide

> **For any AI coding agent** (Claude Code, Cursor, Cline, OpenCode, Hermes, Pi Dev, Aether, Antigravity, or a subagent in this repo). Keep this file <300 lines — link detail, don't duplicate. Single source of truth for public contributors; private deep dives live in `devdocs/` (gitignored) — see `docs/ARCHITECTURE.md` for the 1-page public overview.

Read `docs/README.md` (quick start + curl) and `docs/ARCHITECTURE.md` (pipeline + module table) alongside this file. Treat all three as consistent — same stack, same 17-file tree, same 7 phases.

---

## 1. Stack — decided, not a choice

| Layer | Choice | Version | Notes |
|---|---|---|---|
| **Language** | TypeScript | `5.9` `strict` | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| **Runtime** | Bun (primary) + Node fallback | `Bun 1.4`, `Node >=20` | `Bun.serve` if available, else `@hono/node-server` |
| **Framework** | Hono | `4.x` | Web Standards `Request`/`Response`/`ReadableStream`, no Next.js |
| **Validation** | Zod | `3.x` | Ingress, registry, provider config — single pass |
| **Test** | Vitest | `2.x` + `@vitest/coverage-v8` | In-memory `app.request()`, no TCP |
| **Build** | tsup + tsx | `tsup 8.x`, `tsx 4.x` | `tsup` prod ESM+CJS+DTS, `tsx watch` dev |
| **Lint/Format** | Biome | `1.9` | Replaces ESLint+Prettier, `biome check --write` |
| **PM** | pnpm (primary) + bun compat | `pnpm 9.x` | `pnpm-lock.yaml` tracked |

`hono` + `zod` are the only runtime deps; everything else is `devDependencies`. Never add `next`, `express`, or `axios`.

**Scripts (canonical):**
```bash
pnpm dev          # bun --watch src/index.ts (dev:node = tsx watch)
pnpm test         # vitest run — 40 suites, 568 tests
pnpm test:watch   # vitest
pnpm test:coverage# vitest run --coverage (threshold 85%)
pnpm lint         # biome check .
pnpm lint:fix     # biome check --write .
pnpm typecheck    # tsc --noEmit
pnpm build        # tsup src/index.ts --format esm --dts --clean → dist/index.js ~190 KB
pnpm start        # node dist/index.js
```
---

## 2. Canonical module tree — 17 files, no aliases

```
src/
├── index.ts                              # Hono app factory, middleware order, route wiring, /health(/live|/ready)
├── config/
│   ├── models.ts                         # MODEL_REGISTRY — 114 entries: contextWindow, maxOutputTokens, supportedParams, stripParams (+ syncedSnapshot dynamic fallback)
│   └── providers.ts                      # 32 ProviderSpecs: baseUrl, key env, timeoutMs, relay tier, allowPrivate opt-in
├── intelligence/
│   ├── sync.ts                           # OpenRouter + Artificial Analysis background sync
│   └── scoring.ts                        # valueScore = quality/price, tier ranking
├── normalizer/
│   ├── clamp.ts                          # effective = min(requested, maxOutput, contextWindow - inputTokens - 256)
│   ├── sanitize.ts                       # strip unsupported sampling params per stripParams
│   └── thinking.ts                       # reasoning_effort ↔ budget_tokens map + max_tokens reconciliation
├── translator/
│   ├── openai-to-claude.ts               # OpenAI ↔ Anthropic Messages (system hoist, cache_control)
│   ├── openai-to-gemini.ts               # OpenAI ↔ Gemini generateContent (systemInstruction, thought)
│   └── tools.ts                          # enforceToolResultAdjacency, orphan → text, role-merge
├── streaming/
│   ├── sse.ts                            # SSE formatters, headers, stall synthesis (createMockSSEStream)
│   ├── earlyKeepalive.ts                 # 2 s grace → SSE comment ping `: keepalive` every 3 s
│   └── stallWatchdog.ts                  # 60 s reset-on-chunk → synthesize graceful finish + [DONE]
└── router/
    ├── candidates.ts                     # shared UpstreamCandidate resolution + x-router-action header
    ├── combo.ts                          # fallback / priority / value-driven + least-busy picker
    ├── circuitBreaker.ts                 # error classifier, 60 s sliding window, cooldown cap 300 s
    └── transport.ts                      # SSRF guard (IPv4-mapped IPv6 normalized) relay 25 s watchdog + direct/VPS, allowPrivate opt-in
```

Full `src/` is 30 files — the 17 above are the pipeline core; `src/routes/` (chat, messages, models — breaker & combo wired here), `src/middleware/` (auth, bodyLimit, contentType, requestId, errors), `src/schemas/`, and `src/types.ts` are wiring around that core. Workspace also holds `scripts/import-provider.ts` (registry importer) and the `apps/web/` React dashboard.
`tests/` mirrors `src/` (see §5). Cross-doc invariant: `docs/ARCHITECTURE.md` and `docs/README.md` repeat this core tree verbatim — update all three in one commit if it ever changes.
---

## 3. Request pipeline — 6 stages + registry side-car

```
Client (harness) → 1 Ingress & Auth → 2 Normalizer → 3 Translator → 4 Router & Combo → 5 Transport → 6 Streaming → Client
                     (Hono+Zod)        (clamp/sanitize/thinking)  (OAI↔Claude↔Gemini)  (breaker)      (relay/direct)   (dual-timer)
                                          ↕                           ↕                  ↕
                                       Model Registry (src/config/models.ts) — contextWindow / maxOutput / stripParams
                                       Intelligence (sync.ts + scoring.ts) — advisory, never blocking; fallback is static registry
```

| # | Stage | Where | What | Fail signal |
|---|---|---|---|---|
| 1 | **Ingress & Auth** | `src/index.ts` | RFC 7231 `Content-Type: application/json` guard, JSON body limit, `Authorization: Bearer` / `x-api-key` / `anthropic-api-key` auth (priority order), `x-request-id`, rate-limit semaphore | `415`/`413`/`401` — no retry |
| 2 | **Normalizer** | `src/normalizer/*` + `src/config/models.ts` | sanitize schemas → repair tool adjacency → normalize thinking budget → **clamp** `max_tokens` | `400` immediate reject — never failover |
| 3 | **Translator** | `src/translator/*` | Build target wire payload (OpenAI Chat, Anthropic Messages, Gemini generateContent) | `400` if untranslatable |
| 4 | **Router & Combo** | `src/routes/*` + `src/router/{candidates,combo,circuitBreaker}.ts` | **Wired per route**: shared candidate resolution → combo ordering (wire-compatible providers hosting the same slug) → per-provider breaker Map (`recordSuccess`/`recordFailure`) + `x-router-action` response header | `400` → reject immediately; `429`/`401` → rotate key; `5xx`/timeout → failover next candidate |
| 5 | **Transport** | `src/router/transport.ts` | Vercel relay pool (25 s watchdog, `RELAY_TIMEOUT_MS = 25_000`) → direct/VPS fallback, `x-relay-auth`, SSRF guard normalizing IPv4-mapped IPv6 (`::ffff:`), outbound `allowPrivate` opt-in for loopback local providers (inbound relay targets stay strict), `AbortController` chaining | — |
| 6 | **Streaming** | `src/streaming/*` | Composed `withEarlyKeepalive(withStallWatchdog(raw))` — watchdog wraps the raw upstream so keepalive frames don't starve stall detection; client `close` → upstream `abort()` | Stall → graceful finish, not exception |

Full lifecycle diagram and failure taxonomy → `docs/ARCHITECTURE.md`.

**Invariants:** normalizer is pure & synchronous (no I/O); translators are pure functions (input JSON → output JSON); router/transport own all side effects; streaming never swallows errors (mid-stream failures serialize as SSE error + `[DONE]`).

---

## 4. Setup — <5 min to 200

```bash
git clone https://github.com/trefeon/lmntea-router.git
cd lmntea-router
pnpm install            # or bun install
cp .env.example .env    # set at least AUTH_TOKENS + one upstream key
pnpm dev                # Hono on http://localhost:3000
curl http://localhost:3000/health
# {"status":"ok","uptime":12.3,"version":"0.2.0"}

# Harness smoke (streaming)
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LMNTEA_API_KEY" \
  -d '{"model":"opencode/x-preview-f-free","messages":[{"role":"user","content":"Say hi in one sentence."}],"max_tokens":256,"stream":true}'
# expect data: {"choices":[{"delta":{"content":"Hi"}}]} … data: [DONE]
```

`.env` and `.env.*` are gitignored — never commit them. CI injects secrets via env. `LOG_LEVEL`, `PORT`, relay and intelligence keys are all optional except `AUTH_TOKENS`.

---

## 5. Testing — hermetic invariant

**Invariant:** `env -u AUTH_TOKENS pnpm test` must pass with no secrets and no network. Same `pnpm test` on a clean checkout, on CI, and locally must be hermetic. `test/setup.ts` injects deterministic defaults (`sk-test-hermetic-*`) when env is absent.

```bash
env -u AUTH_TOKENS pnpm test        # hermetic gate — CI
pnpm test                           # normal dev (uses .env if present)
pnpm test --coverage                # threshold 85% lines/branches/functions/statements
pnpm test:watch
```

**Rules:**

- Use `app.request()` (Hono in-memory), never `app.listen` / `fetch("http://localhost:…")` / open ports. ~2 ms per test, no cleanup.
- Mock upstream `fetch` per test: `vi.stubGlobal('fetch', mockFetch)`. Never hit `openrouter.ai` or live providers in unit/integration — only an explicit `E2E=1` job may do real HTTP (under `tests/e2e/`, gated `if (!process.env.E2E) it.skip(...)`).
- Translators are pure — unit-test via direct import without HTTP.
- Streaming: assert on `Response.body` chunks and SSE shapes (`data:` for OpenAI, `event:`/`data:` for Anthropic, terminal `data: [DONE]`). Use `vi.useFakeTimers()` for keepalive/watchdog timing.
- No `test.only` / `describe.only` — CI sets `forbidOnly: true`.
- Coverage is enforced in `vitest.config.ts` (85% hard fail, excludes `tests/**`, `dist/**`).

```ts
// Canonical pattern — no server.listen()
import { app } from '@/index.js';
test('clamps max_tokens for opencode/x-preview-f-free to 131072', async () => {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-test-hermetic-1' },
    body: JSON.stringify({ model: 'opencode/x-preview-f-free', messages: [{ role: 'user', content: 'hi' }], max_tokens: 200_000 }),
  });
  expect(res.status).toBe(200);
});
```

Error classifier to keep in mind (asserted in tests): `400` → `REJECT_IMMEDIATE` (no retry); `401/429` → rotate key; `5xx`/`504`/timeout/stall → failover to next combo candidate; 3× `5xx` in 60 s → trip circuit breaker (cooldown 60 s, cap 300 s). Relay timeout = `25_000` ms, stream stall = `60_000` ms, early keepalive grace = `2_000` ms.

Detail → `docs/README.md` § Features and `docs/ARCHITECTURE.md` § Data Flow (public) — full case matrix in the private `devdocs/04-TESTING.md` when you have repo access.

---

## 6. Research grounding — don't invent limits

If you have the private checkout (contains `research/` + `reference/` + `devdocs/` — gitignored, absent on fresh GitHub clones):

- Before touching `config/models.ts` / `normalizer/*`, read `research/per_model_failure_analysis.md` (§3 clamp table is normative — `x-preview-f-free → 131072`, `laguna → 262144` window, `deepseek-v4-flash → 200000`, etc.) and `research/openrouter_models_specification.md`.
- Before touching `translator/*`, read `research/universal_protocol_translation_spec.md` (wire table, role alternation, tool adjacency/orphan repair, reasoning matrix).
- Before touching `streaming/*`, read `research/comparative_architecture_study.md` §3.
- Before touching `router/*` or relay/transport, read `research/proxy_pools_vercel_relay_audit.md` (hardened `x-relay-auth` + `isPrivateHostname` SSRF guard + 25 s watchdog).
- Anti-pattern: do not paste raw `reference/9router` or `reference/OmniRoute` source into prompts — the distilled docs already cite the exact upstream PR.

If you only have public access, `docs/ARCHITECTURE.md` is the self-contained source of truth. In either case: **cite the doc or `reference/` file that justifies a provider limit in your PR description — never guess a `contextWindow` or `maxOutputTokens`.**

```
# Ground an agent prompt (copy-paste)
You are working on lmntea-router (TS+Hono+Bun). Before writing code:
1. Read docs/ARCHITECTURE.md for the pipeline and module tree.
2. If research/ is present, read the relevant research doc for your area (see table above).
3. Keep the 17-file tree and 6-stage pipeline unchanged.
4. Translators are pure functions; streaming uses Web Streams; tests use app.request().
Do not invent provider limits — cite a research/ doc or reference/ file.
```

---

## 7. Branch & commit conventions

- **Branches:** `feat/p<n>-<slug>` per roadmap phase (e.g. `feat/p2-normalizer`, `feat/p3-translator`, `feat/add-volcengine-kimi-k2`), or `fix/<slug>`, `chore/<slug>`, `docs/<slug>`. One phase/slice per branch.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`) with scope when useful (`feat(router): add value-driven combo`). Keep commits reviewable — one logical change each.
- **PRs:** One phase or one provider per PR. Description must include: registry diff, translator diff, transport tier note, test evidence (`pnpm test` + relevant integration case), and the `research/` citation for clamp values.
- **Gates (must pass before merge):** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Husky pre-commit runs `biome check --write --staged`, `tsc --noEmit`, `vitest related --run`.
- **Phases (canonical order, dependency-locked):** P0 Bootstrap & Tooling → P1 Ingress & Auth → P2 Normalizer & Registry → P3 Translator → P4 Streaming Engine → P5 Router & Relay → P6 Intelligence & Polish. Don't start P3 before P2; P5 needs P2+P3+P4. See `docs/README.md` § Roadmap and `docs/ARCHITECTURE.md` § Phases.

---

## 8. Where to add a new provider/model — import-first workflow

Follow in order, no shims, no deprecated paths. Canonical tool: `scripts/import-provider.ts`.

**Step 1 — Dry-run audit**

```bash
bun scripts/import-provider.ts --provider <id> [--source openrouter|9router|omnroute|all] --dry-run
```

Review before writing: model ids, contextWindow / maxOutputTokens mapping, stripParams derivation, skipped placeholders. Spot-check ceilings against upstream docs — never guess.

**Step 2 — Append-only merge into the registry**

```bash
bun scripts/import-provider.ts --provider <id> --merge
```

`--merge` splices only entries absent from the COMMITTED `src/config/models.ts` + `src/config/providers.ts`, alphabetically inside `MODEL_REGISTRY` / `PROVIDERS`; existing bodies and tail functions are untouched by construction. NEVER run the importer without `--merge` against committed config — wholesale regeneration overwrites hand-maintained entries. Add any new env var (`apiKeyEnv`) to `.env.example` with a safe default.

**Step 3 — Presence check & wiring**

- Aggregator-hosted slug (frontier-lab model also carried by openrouter/requesty/…): don't duplicate it statically unless you need provider-specific overrides — static wins for known ids and `buildUpstreamCandidates` + `routeCombo` already order wire-compatible providers hosting the same slug. Note expected failover order in the PR.
- Brand-new provider: verify the merged `providers.ts` entry (`baseUrl`, `apiKeyEnv`, `timeoutMs`, `format`); local loopback providers additionally set `allowPrivate: true` (outbound SSRF opt-in).
- Wire-format notes: OpenAI-compatible JSON needs no new translator; Anthropic Messages extends `openai-to-claude.ts`, Gemini `generateContent` extends `openai-to-gemini.ts` (translators stay pure functions); reasoning models touch `src/normalizer/thinking.ts`.

**Step 4 — Required coverage for a provider PR** (all via `app.request()` + mocked `fetch`):

- [ ] **Clamp test** — `max_tokens: 999999` clamps to the provider ceiling (`32768` for Kimi, `131072` for OpenCode, `200000` for CommandCode).
- [ ] **Sanitize test** — unsupported params stripped (e.g. `temperature` on o1/DeepSeek).
- [ ] **Translation test** — OpenAI → provider wire shape round-trips (messages, tools, system, media parts).
- [ ] **Tool adjacency test** — `assistant(tool_calls) → user(tool_result)` holds; orphans degrade to user text.
- [ ] **Integration test** — `app.request('/v1/chat/completions', { model: 'your/new-model' })` returns `200` with mocked upstream.

**Gates:** `pnpm typecheck && pnpm lint && env -u AUTH_TOKENS pnpm test && pnpm build`, then ONE commit per provider with the registry diff, test evidence, and the citation justifying each clamp value.

---

## 9. Guardrails

- Keep `hono` + `zod` minimal — no framework drift.
- No mutation outside `normalizer/` — every param change is registry-driven and tested.
- Relay is authenticated (`x-relay-auth` 32B hex) and SSRF-hardened (`isPrivateHostname` with IPv4-mapped-IPv6 normalization + protocol allowlist) on every deploy; loopback is reachable only via per-provider `allowPrivate` opt-in.
- Vercel relays are bounded (25 s TTFT watchdog) with direct/VPS failover before the platform timeout.
- Do not commit `.env`, `*.log`, or `reference/`/`research/` artifacts — all gitignored. Fresh clone → `cp .env.example .env && pnpm install && env -u AUTH_TOKENS pnpm test` must be green.

---

## Further reading

- `docs/README.md` — landing page, features, quick start, curl examples, project structure.
- `docs/ARCHITECTURE.md` — pipeline diagram, module table, data-flow invariants, phases P0–P6.
- Private (repo access only, gitignored): `devdocs/README.md` (doc index + research index + agent context guide), `devdocs/SETUP.md` (full setup + provider checklist), `devdocs/02-ROADMAP.md` (7-phase plan with exit criteria), `devdocs/04-TESTING.md` (full test matrix), plus `research/` (12 synthesis docs) and `reference/` (9 upstream checkouts).

License: MIT — see `LICENSE`.

