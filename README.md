# lmntea-router

<p align="center">
  <strong>Clean-slate LLM gateway for AI coding harnesses — compact Hono core, declarative 32-provider registry.</strong>
</p>

<p align="center">
  <a href="#"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="#"><img alt="Hono" src="https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white" /></a>
  <a href="#"><img alt="Bun" src="https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white" /></a>
  <a href="#"><img alt="Vitest" src="https://img.shields.io/badge/Vitest-2.x-6E9F18?logo=vitest&logoColor=white" /></a>
  <a href="#"><img alt="Zod" src="https://img.shields.io/badge/Zod-3.x-3E67B1" /></a>
  <a href="#"><img alt="License" src="https://img.shields.io/badge/License-MIT-green" /></a>
</p>

> **Stack:** `TypeScript 5.9 (strict) + Hono 4.x + Bun 1.4 (Node ≥20 fallback) + Vitest 2.x + Zod 3.x + tsup + tsx`
> **Current release:** [v0.2.0](https://github.com/trefeon/lmntea-router/releases/tag/v0.2.0)

---

## What is lmntea-router?

`lmntea-router` is a lightweight, modular **LLM gateway** built exclusively for **AI coding harnesses** — the tools that drive autonomous development:

`Claude Code` · `Cursor` · `Cline` · `OpenCode` · `Hermes` · `Pi Dev` · `Aether` · `Antigravity`

It sits between your harness and **32 upstream providers** — from frontier clouds (`OpenAI`, `Anthropic`, `Gemini`) through regional labs (`DeepSeek`, `Kimi`, `GLM`) and aggregators (`OpenRouter`, `Together`, `Groq`) down to local runtimes (`Ollama`) — and eliminates the failure modes that plague generic gateways. No 350-provider bloat. No 80k-LOC legacy. Just the six-stage pipeline a coding agent actually needs.

**Why not fork 9router / OmniRoute?** Those projects are excellent but carry historical weight: 9router ships raw JS with ad-hoc parameter handling and unauthenticated relays; OmniRoute ships 350+ providers and 50+ sub-handlers. `lmntea-router` is a **clean-slate** rewrite — a compact pipeline core around a declarative model registry — that ports only the proven patterns: declarative clamping, dual-timer streaming, circuit-breaker combo routing, on a Hono + Web Streams foundation.

---

## Providers & Models

| Group | Providers |
|---|---|
| **Frontier clouds** | `openai` · `anthropic` · `gemini` · `bedrock` (AWS) · `vertex` (GCP) |
| **Harness-native relays** | `opencode` (OpenCode Zen) · `commandcode` |
| **Regional & specialty labs** | `deepseek` · `moonshot` (Kimi) · `zai` (GLM) · `minimax` · `volcengine` (Ark) · `xiaomi-mimo` · `alibaba` (Qwen) · `mistral` · `cohere` · `perplexity` |
| **Aggregators & inference hosts** | `openrouter` · `requesty` · `orcarouter` · `aihorde` · `together` · `fireworks` · `groq` · `cerebras` · `nvidia` · `nebius` · `hyperbolic` · `siliconflow` · `deepinfra` · `huggingface` |
| **Local** | `ollama` (loopback via opt-in `allowPrivate`) |

**Models:** 114 static registry entries (`src/config/models.ts`) with verified `contextWindow` / `maxOutputTokens` / `supportedParams` / `stripParams`, plus ~419 OpenRouter models served dynamically through the intelligence-sync snapshot fallback. The static registry always wins for known ids — remote capabilities are never advertised unverified. (Azure support is deferred until env-driven `baseUrl` lands.)

## Features

| Pillar | What it does | Why it matters |
|---|---|---|
| **Universal Translation** | Bidirectional `OpenAI ↔ Anthropic ↔ Gemini` wire-format conversion: role mapping, tool adjacency / orphan repair, reasoning / thinking normalization (`reasoning_content` ↔ `thinking.budget_tokens` ↔ `thought: true`), schema sanitization (strip unsupported keywords, merge consecutive same-role turns) | One harness config works with every upstream — no per-provider client patches |
| **Declarative Clamp & Sanitize** | Per-model `contextWindow` / `maxOutputTokens` / `supportedParams` registry (`src/config/models.ts`). Dynamic clamp: `effective_max = min(client_max, model.maxOutput, contextWindow - inputTokens - 256)` with terminal default 8192 for Claude-style clients. Auto-strip unsupported sampling params on reasoning models | Eliminates **276 HTTP 400** parameter violations observed in production (`max_tokens illegal: [1,131072]`) |
| **Resilient Dual-Timer Streaming** | Composed as `withEarlyKeepalive(withStallWatchdog(raw))` — the watchdog wraps the raw upstream stream so keepalive frames never starve stall detection. `earlyKeepalive` (2 s grace, then `: keepalive\n\n` ping until first token) + `stallWatchdog` (60 s reset-on-chunk timer with graceful `finish_reason: stop` synthesis) + upstream `AbortController` on client disconnect | Eliminates **109 HTTP 504** Vercel timeouts + **11 stream stalls** that kill long reasoning runs |
| **Wired Smart Routing** | Every route handler runs shared candidate resolution (`src/router/candidates.ts`) → combo ordering (`fallback`, `priority`, `value-driven`; wire-compatible providers hosting the same slug are ordered automatically) → per-provider circuit breaker (`classifyError`: 400 → reject immediately, 429/401 → rotate key, 5xx/timeout → failover + 60 s cooldown capped at 300 s) with `recordSuccess`/`recordFailure` bookkeeping and an `x-router-action` response header documenting every rotate/failover decision | No cascading lockouts; transient blips retry on the next candidate, real outages trip cleanly — and clients can see why |

Plus: prompt-caching breakpoint hoisting (`cache_control` under a global ≤4-breakpoint budget spanning tools + system + messages), image/PDF media part translation, health-scored model intelligence (OpenRouter + Artificial Analysis, advisory-only background sync every 6 h).

---

## Quick Start

**Prerequisites:** `Bun 1.4+` (or `Node 20+`), `pnpm 9+`

```bash
# 1. Clone
git clone https://github.com/trefeon/lmntea-router.git
cd lmntea-router

# 2. Install
pnpm install

# 3. Configure
cp .env.example .env
# edit .env — set AUTH_TOKENS (comma-separated client keys) and at least one upstream key (OPENAI_API_KEY / ANTHROPIC_API_KEY)

# 4. Run (hot reload)
pnpm dev
```

```bash
# Liveness — version reflects the running release
curl http://localhost:3000/health
# {"status":"ok","uptime":12.34,"version":"0.2.0"}
```

### Try it — OpenAI-compatible (non-stream)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LMNTEA_API_KEY" \
  -d '{
    "model": "opencode/x-preview-f-free",
    "messages": [{"role": "user", "content": "Write a hello world in Go"}],
    "max_tokens": 2048,
    "stream": false
  }'
# → {"id":"chatcmpl-...","choices":[{"message":{"content":"..."}}],"usage":{...}}
```

(`$LMNTEA_API_KEY` = any key listed in your `AUTH_TOKENS`.)

### Try it — OpenAI-compatible (stream)

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LMNTEA_API_KEY" \
  -d '{
    "model": "opencode/x-preview-f-free",
    "messages": [{"role": "user", "content": "Write a hello world in Go"}],
    "max_tokens": 2048,
    "stream": true
  }'
# → data: {"choices":[{"delta":{"content":"package"}}]} ... data: [DONE]
#   upstream slow? expect `: keepalive` comment frames every 3 s after 2 s grace
```

### Try it — Anthropic-compatible (non-stream)

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $LMNTEA_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 2048,
    "messages": [{"role": "user", "content": "Explain circuit breakers in 3 bullets"}]
  }'
# → {"id":"msg_...","content":[{"type":"text","text":"..."}]}
```

### Try it — Anthropic-compatible (stream)

```bash
curl -N http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $LMNTEA_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 2048,
    "stream": true,
    "messages": [{"role": "user", "content": "Explain circuit breakers in 3 bullets"}]
  }'
# → event: message_start / event: content_block_delta ... data: [DONE]
```

### Other endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/models` | Enriched model list (static registry first; context window, modalities, TPS/TTFT when intelligence sync is enabled) |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| `POST` | `/v1/messages` | Anthropic Messages (stream + non-stream) |
| `GET` | `/health` | Liveness probe reporting `{ status, uptime, version }` (`/health/live`, `/health/ready` also available) |
| `GET` | `/` | Built-in web dashboard (React 19 + Vite app served from `apps/web/dist`; exempt from bearer auth, as are `/assets/*` and favicon) |

## Project Structure

Canonical pipeline core — 17 files (same everywhere — `docs/`, code, `AGENTS.md`). Full `src/` is 30 files including routes/middleware/schemas wiring and one co-located test:

```
src/
├── index.ts                              # Hono app factory, middleware order, route wiring, /health*
├── config/
│   ├── models.ts                         # MODEL_REGISTRY — 114 entries: contextWindow, maxOutputTokens, supportedParams, stripParams (+ syncedSnapshot fallback for dynamic ids)
│   └── providers.ts                      # 32 ProviderSpecs: baseUrl, key env, timeout, relay tier, allowPrivate opt-in
├── intelligence/
│   ├── sync.ts                           # Background sync (OpenRouter + Artificial Analysis), 6 h interval, never blocks requests
│   └── scoring.ts                        # Quality / price value score (is it worth it?)
├── normalizer/
│   ├── clamp.ts                          # Dynamic max_tokens & context-window budgeting
│   ├── sanitize.ts                       # Strip unsupported sampling params
│   └── thinking.ts                       # Budget & reasoning token normalization
├── translator/
│   ├── openai-to-claude.ts               # OpenAI ↔ Anthropic Messages (cache_control budget)
│   ├── openai-to-gemini.ts               # OpenAI ↔ Gemini generateContent (thoughtSignature merge)
│   └── tools.ts                          # Strict tool adjacency & orphan repair
├── streaming/
│   ├── sse.ts                            # SSE formatters, headers, stall synthesis
│   ├── earlyKeepalive.ts                 # 2 s grace → : keepalive ping every 3 s
│   └── stallWatchdog.ts                  # 60 s reset-on-chunk watchdog + graceful finish
├── router/
│   ├── candidates.ts                     # Shared UpstreamCandidate resolution + x-router-action header
│   ├── combo.ts                          # Fallback / priority / value-driven routing
│   ├── circuitBreaker.ts                 # Error classifier & cooldowns
│   └── transport.ts                      # SSRF-guarded relay + direct dispatch, 25 s relay watchdog
├── routes/                               # Hono route handlers (chat, messages, models) — breaker & combo wired here
├── middleware/                           # auth (timing-safe digest), bodyLimit, contentType, requestId, errors
└── schemas/                              # Zod ingress schemas (chat, messages)
scripts/import-provider.ts                # Provider/model importer (--dry-run audit, --merge append-only splice)
apps/web/                                 # React 19 + Vite dashboard workspace (dev proxies /v1 + /health to the gateway)
```

Core 17 = the pipeline stages (index + config 2 + intelligence 2 + normalizer 3 + translator 3 + streaming 3 + router 4). `routes/`, `middleware/`, `schemas/`, and `types.ts` are the wiring around that core.

See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for the 6-stage pipeline diagram and module table.

### Build

```bash
pnpm build        # tsup src/index.ts --format esm --dts --clean
# dist/index.js      ~190 KB — ESM bundle
# dist/index.js.map  ~370 KB — sourcemap
# dist/index.d.ts    370 B — type declarations
pnpm start        # node dist/index.js
pnpm typecheck    # tsc --noEmit
```

### Tests

```bash
env -u AUTH_TOKENS pnpm test   # hermetic gate (CI): 40 suites, 568 tests, no secrets, no network
pnpm test                      # normal dev (uses .env if present)
pnpm test:coverage             # vitest run --coverage (threshold 85%)
```
All tests run hermetically via Hono's in-memory `app.request()` — no ports, no live upstreams.

---

## Roadmap

7 phases — all shipped as of v0.2.0:

| Phase | Name | Goal |
|---|---|---|
| **P0** | Bootstrap & Tooling | Repo, TS + Hono + Bun + Vitest + Zod + tsup/tsx, CI |
| **P1** | Ingress & Auth | `POST /v1/chat/completions`, `/v1/messages`, `GET /v1/models`, key auth, rate-limit semaphore |
| **P2** | Normalizer & Registry | Model registry, clamp, sanitize, thinking reconciliation |
| **P3** | Translator | OpenAI↔Claude↔Gemini converters, tool repair, role merging |
| **P4** | Streaming Engine | Dual-timer engine, SSE writer, abort propagation |
| **P5** | Router & Relay | Combo engine, circuit breaker, Vercel relay pool (25 s bound) |
| **P6** | Intelligence & Polish | OpenRouter/AA sync, scoring, web dashboard, hardening |

Post-P6 expansion (32 providers, 114+ models, router wired into routes, SSRF hardening) shipped through [v0.2.0](https://github.com/trefeon/lmntea-router/releases/tag/v0.2.0). Detailed milestones → `devdocs/02-ROADMAP.md` (private, gitignored).

---

## Reference & Research

This repo ships with deep prior-art analysis — **local only, gitignored** (`/reference/`, `/research/`, `/devdocs/` per `.gitignore`), so clones from GitHub won't contain them. Contributors with repo access:

- `reference/` — 9 checkouts for source-truth: `9router`, `OmniRoute`, `litellm`, `portkey-gateway`, `new-api`, `vercel-ai`, `openai-node`, `anthropic-sdk-typescript`, `opencode`, plus `openapi/` specs. Use before inventing a translation rule — the answer is already ported and cited.
- `research/` — 12 synthesis docs (see `devdocs/README.md` → Research Index for one-line summaries). Start with `lmntea_router_master_design.md` and `universal_protocol_translation_spec.md`.
- `devdocs/` — Private engineering docs: `00-TECH-STACK.md` (ADR), `01-ARCHITECTURE.md`, `02-ROADMAP.md`, `03-API-CONTRACTS.md`, `04-TESTING.md`, `05-DEPLOYMENT.md`, plus `SETUP.md`.

> If you only have public access, `docs/ARCHITECTURE.md` is the self-contained 1-page overview.

---

## License

MIT — see [`LICENSE`](../LICENSE).

---

<p align="center"><sub>Built for coding agents. Boring infra, sharp edges removed.</sub></p>
