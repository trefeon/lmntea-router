# lmntea-router

<p align="center">
  <strong>Clean-slate LLM gateway for AI coding harnesses — 1,500–2,500 LOC, zero bloat.</strong>
</p>

<p align="center">
  <a href="#"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="#"><img alt="Hono" src="https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white" /></a>
  <a href="#"><img alt="Bun" src="https://img.shields.io/badge/Bun-1.2-000000?logo=bun&logoColor=white" /></a>
  <a href="#"><img alt="Vitest" src="https://img.shields.io/badge/Vitest-2.x-6E9F18?logo=vitest&logoColor=white" /></a>
  <a href="#"><img alt="Zod" src="https://img.shields.io/badge/Zod-3.x-3E67B1" /></a>
  <a href="#"><img alt="License" src="https://img.shields.io/badge/License-MIT-green" /></a>
</p>

> **Stack:** `TypeScript 5.6 + Hono 4.x + Bun 1.2 (Node 20 fallback) + Vitest 2.x + Zod 3.x + tsup + tsx`

---

## What is lmntea-router?

`lmntea-router` is a lightweight, modular **LLM gateway** built exclusively for **AI coding harnesses** — the tools that drive autonomous development:

`Claude Code` · `Cursor` · `Cline` · `OpenCode` · `Hermes` · `Pi Dev` · `Aether` · `Antigravity`

It sits between your harness and upstream providers (`OpenAI`, `Anthropic`, `Gemini`, `DeepSeek`, `OpenCode Zen`, `MiniMax`, `Kimi`, `Volcengine Ark`, `Bedrock`, `Ollama`) and eliminates the failure modes that plague generic gateways. No 350-provider bloat. No 80k-LOC legacy. Just the 5 layers a coding agent actually needs.

**Why not fork 9router / OmniRoute?** Those projects are excellent but carry historical weight: 9router ships raw JS with ad-hoc parameter handling and unauthenticated relays; OmniRoute ships 350+ providers and 50+ sub-handlers. `lmntea-router` is a **clean-slate** rewrite (~1,500–2,500 LOC) that ports only the proven patterns — declarative clamping, dual-timer streaming, circuit-breaker combo routing — into a Hono + Web Streams foundation.

---

## Features

| Pillar | What it does | Why it matters |
|---|---|---|
| **Universal Translation** | Bidirectional `OpenAI ↔ Anthropic ↔ Gemini` wire-format conversion: role mapping, tool adjacency / orphan repair, reasoning / thinking normalization (`reasoning_content` ↔ `thinking.budget_tokens` ↔ `thought: true`), schema sanitization (strip unsupported keywords, merge consecutive same-role turns) | One harness config works with every upstream — no per-provider client patches |
| **Declarative Clamp & Sanitize** | Per-model `contextWindow` / `maxOutputTokens` registry (`src/config/models.ts`). Dynamic clamp: `effective_max = min(client_max, model.maxOutput, contextWindow - inputTokens - 256)`. Auto-strip `temperature`/`top_p` on reasoning models (o1/o3/DeepSeek) | Eliminates **276 HTTP 400** parameter violations observed in production (`max_tokens illegal: [1,131072]`) |
| **Resilient Dual-Timer Streaming** | `earlyKeepalive` (2 s SSE comment ping `: keepalive\n\n` until first token) + `stallWatchdog` (60 s reset-on-chunk timer with graceful `finish_reason: stop` synthesis) + upstream `AbortController` on client disconnect | Eliminates **109 HTTP 504** Vercel timeouts + **11 stream stalls** that kill long reasoning runs |
| **Smart Routing** | Combo engine (`fallback`, `priority`, `value-driven`) + per-model circuit breaker (error classifier: 400 → reject, 429/401 → rotate key, 5xx/timeout → failover + 60 s cooldown, cap 300 s) + Vercel relay pool with **25 s watchdog** and direct/VPS fallback + least-busy key selection | No cascading lockouts; transient blips retry, real outages trip cleanly |

Plus: prompt-caching breakpoint hoisting, image/PDF media part translation, health-scored model intelligence (OpenRouter + Artificial Analysis).

---

## Quick Start

**Prerequisites:** `Bun 1.2+` (or `Node 20+`), `pnpm 9+`

```bash
# 1. Clone
git clone https://github.com/trefeon/lmntea-router.git
cd lmntea-router

# 2. Install
pnpm install

# 3. Configure
cp .env.example .env
# edit .env — set at least one upstream key (OPENAI_API_KEY / ANTHROPIC_API_KEY)

# 4. Run (hot reload)
pnpm dev
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
| `GET` | `/v1/models` | Enriched model list (context window, modalities, TPS/TTFT when intelligence sync is enabled) |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| `POST` | `/v1/messages` | Anthropic Messages (stream + non-stream) |
| `GET` | `/health` | Liveness probe (`/health/live`, `/health/ready` also available) |
## Project Structure

Canonical pipeline core — 16 files (same everywhere — `docs/`, code, `AGENTS.md`). Full `src/` is 29 files including routes/middleware/schemas + SSE helpers:

```
src/
├── index.ts                              # Hono app, ingress, route wiring
├── config/
│   ├── models.ts                         # Declarative Model Registry & parameter bounds
│   └── providers.ts                      # Upstream endpoints & API keys
├── intelligence/
│   ├── sync.ts                           # Background sync (OpenRouter + Artificial Analysis)
│   └── scoring.ts                        # Quality / price value score (is it worth it?)
├── normalizer/
│   ├── clamp.ts                          # Dynamic max_tokens & context-window budgeting
│   ├── sanitize.ts                       # Strip unsupported sampling params
│   └── thinking.ts                       # Budget & reasoning token normalization
├── translator/
│   ├── openai-to-claude.ts               # OpenAI ↔ Anthropic Messages
│   ├── openai-to-gemini.ts               # OpenAI ↔ Gemini generateContent
│   └── tools.ts                          # Strict tool adjacency & orphan repair
├── streaming/
│   ├── sse.ts                            # SSE formatters, headers, stall synthesis
│   ├── earlyKeepalive.ts                 # 2 s SSE comment ping (: keepalive)
│   └── stallWatchdog.ts                  # 60 s reset-on-chunk watchdog + graceful finish
├── router/
│   ├── combo.ts                          # Fallback / priority / value-driven routing
│   ├── circuitBreaker.ts                 # Error classifier & cooldowns
│   └── transport.ts                      # Relay + direct dispatch, 25 s Vercel watchdog
├── routes/                               # Hono route handlers (chat, messages, models)
├── middleware/                           # auth, bodyLimit, contentType, requestId, errors
└── schemas/                              # Zod ingress schemas (chat, messages)
```

Core 16 = the pipeline stages (index + config 2 + intelligence 2 + normalizer 3 + translator 3 + streaming 3 + router 3). `routes/`, `middleware/`, `schemas/`, and `streaming/sse.ts` are the wiring + helpers around that core.

See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for the 6-stage pipeline diagram and module table.

### Build

```bash
pnpm build        # tsup src/index.ts --format esm --dts --clean
# dist/index.js      ~60 KB (59.96 KB) — ESM bundle
# dist/index.js.map  ~160 KB — sourcemap
# dist/index.d.ts    370 B — type declarations
pnpm start        # node dist/index.js
pnpm typecheck    # tsc --noEmit
```

### Tests

```bash
pnpm test         # 21 suites, 327 tests — hermetic via app.request(), no ports
pnpm test:coverage# vitest run --coverage (threshold 85%)
```
See [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for the request pipeline diagram and module table.

---

## Roadmap

7 phases, implemented in order:

| Phase | Name | Goal |
|---|---|---|
| **P0** | Bootstrap & Tooling | Repo, TS + Hono + Bun + Vitest + Zod + tsup/tsx, CI |
| **P1** | Ingress & Auth | `POST /v1/chat/completions`, `/v1/messages`, `GET /v1/models`, key auth, rate-limit semaphore |
| **P2** | Normalizer & Registry | Model registry, clamp, sanitize, thinking reconciliation |
| **P3** | Translator | OpenAI↔Claude↔Gemini converters, tool repair, role merging |
| **P4** | Streaming Engine | Dual-timer engine, SSE writer, abort propagation |
| **P5** | Router & Relay | Combo engine, circuit breaker, Vercel relay pool (25 s bound) |
| **P6** | Intelligence & Polish | OpenRouter/AA sync, scoring, docs, hardening |

Detailed milestones → `devdocs/02-ROADMAP.md` (private, gitignored).

---

## Reference & Research

This repo ships with deep prior-art analysis — **local only, gitignored** (`/reference/`, `/research/`, `/devdocs/` per `.gitignore`), so clones from GitHub won't contain them. Contributors with repo access:

- `reference/` — 9 checkouts for source-truth: `9router`, `OmniRoute`, `litellm`, `portkey-gateway`, `new-api`, `vercel-ai`, `openai-node`, `anthropic-sdk-typescript`, `opencode`, plus `openapi/` specs. Use before inventing a translation rule — the answer is already ported and cited.
- `research/` — 12 synthesis docs (see `devdocs/README.md` → Research Index for one-line summaries). Start with `lmntea_router_master_design.md` and `universal_protocol_translation_spec.md`.
- `devdocs/` — Private engineering docs: `00-TECH-STACK.md` (ADR), `01-ARCHITECTURE.md`, `02-ROADMAP.md`, `03-API-CONTRACTS.md`, `04-TESTING.md`, `05-DEPLOYMENT.md`, plus `SETUP.md`.

> If you only have public access, `docs/ARCHITECTURE.md` is the self-contained 1-page overview.

---

## License

MIT — see [`LICENSE`](../LICENSE) (placeholder; replacement on first public release tags the chosen license).

---

<p align="center"><sub>Built for coding agents. Boring infra, sharp edges removed.</sub></p>
