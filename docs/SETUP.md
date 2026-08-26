# Setup — lmntea-router

> **Time:** <5 minutes from zero to `curl` 200.
> **Stack (decided):** `TypeScript 5.9 + Hono 4.13 + Bun 1.4 (Node >=20) + Vitest 2.x + Zod 3.25 + tsup + tsx + Biome + pnpm`

This guide is for a new human contributor **or** an AI agent bootstrapping the repo locally. Every command is copy-pasteable on Windows (Git Bash / PowerShell), macOS, and Linux. For the request pipeline and module map see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Prerequisites

| Requirement | Version | Check | Notes |
|---|---|---|---|
| **Bun** (preferred) | `1.4+` | `bun --version` | Primary runtime — Hono + Web Streams natively. https://bun.sh |
| **Node** (fallback) | `20+` | `node --version` | Used if Bun is unavailable; `tsx` provides the same dev loop |
| **pnpm** | `9+` | `pnpm --version` | Package manager — `npm`/`yarn` work but CI uses `pnpm` |
| **Git** | any | `git --version` | |

No Docker, no database, no external service required — the gateway runs entirely in-memory with a static `MODEL_REGISTRY` fallback if intelligence sync is disabled.

> **Windows note:** Use **Git Bash** (ships with Git for Windows) for the `cp`/`curl` snippets below, or translate to PowerShell (`Copy-Item`, `Invoke-RestMethod`). Bun on Windows is supported as of 1.1.

---

## 1. Clone

```bash
git clone https://github.com/trefeon/lmntea-router.git
cd lmntea-router
```

---

## 2. Install

```bash
pnpm install
```

What this installs:

- `hono` 4.x — Web Standards HTTP framework
- `zod` 3.x — runtime + compile-time schema validation
- `vitest` 2.x — in-memory `app.request()` tests (no ports)
- `tsup` + `tsx` — build & dev runner
- `biome` — format + lint (replaces ESLint/Prettier)

Verify:

```bash
pnpm exec tsc --noEmit   # typecheck should pass on a clean checkout
```

---

## 3. Environment

```bash
cp .env.example .env
```

Edit `.env`. The table below is authoritative and matches `.env.example` — keep them in sync.

### Env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port the gateway listens on |
| `AUTH_TOKENS` | No* | `sk-lmntea-dev-1,sk-lmntea-dev-2` (example) | Comma-separated API keys the gateway accepts. Sent by harnesses as `Authorization: Bearer <token>` or `x-api-key`. Hashed at rest. Empty → hermetic (no auth, convenient for local tests) |
| `RELAY_AUTH_SECRET` | No | _(empty)_ | Shared secret for the Vercel relay pool (`x-relay-auth` header). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (64 hex chars). Must match the relay deployment |
| `ARTIFICIAL_ANALYSIS_API_KEY` | No | _(empty)_ | Optional — Artificial Analysis API v2 key for P6 intelligence sync (quality / TPS / TTFT). Gateway works without it via static `MODEL_REGISTRY` |
| `LOG_LEVEL` | No | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OPENROUTER_API_URL` | No | `https://openrouter.ai/api/v1/models` | Optional override for the OpenRouter Models API (public, no auth required) |

\* `AUTH_TOKENS` is optional for local dev so tests stay hermetic. **Set it in any shared or deployed environment.** When set, every `POST /v1/chat/completions`, `POST /v1/messages`, and `GET /v1/models` requires a matching token.

### Upstream provider keys

Each provider reads its key from one env var (`apiKeyEnv` in `src/config/providers.ts`). **All are
optional** — set only the ones you route to. Most follow `PROVIDER.toUpperCase()_API_KEY`; the
exceptions are marked.

| Provider (`model/` prefix) | Env var | Notes |
|---|---|---|
| `opencode/` | `OPENCODE_API_KEY` | exception to the pattern |
| `commandcode/` | `COMMANDCODE_API_KEY` | |
| `openai/` | `OPENAI_API_KEY` | |
| `anthropic/` | `ANTHROPIC_API_KEY` | |
| `gemini/` | `GEMINI_API_KEY` | |
| `deepseek/` | `DEEPSEEK_API_KEY` | |
| `moonshot/` | `MOONSHOT_API_KEY` | |
| `zai/` | `ZAI_API_KEY` | Anthropic-wire endpoint |
| `minimax/` | `MINIMAX_API_KEY` | |
| `volcengine/` | `VOLCENGINE_API_KEY` | |
| `xiaomi-mimo/` | `XIAOMI_API_KEY` | exception to the pattern |
| `bedrock/` | `AWS_BEARER_TOKEN_BEDROCK` | AWS SigV4/bearer, not a `<PROVIDER>_API_KEY` |
| `alibaba/` | `ALIBABA_API_KEY` | |
| `vertex/` | `VERTEX_API_KEY` | |
| `cohere/` | `COHERE_API_KEY` | |
| `mistral/` | `MISTRAL_API_KEY` | |
| `perplexity/` | `PERPLEXITY_API_KEY` | |
| `ollama/` | _(none)_ | local loopback server — `allowPrivate`, no key |
| `openrouter/` | `OPENROUTER_API_KEY` | also enables dynamic model passthrough |
| `requesty/` | `REQUESTY_API_KEY` | |
| `orcarouter/` | `ORCAROUTER_API_KEY` | |
| `aihorde/` | `AIHORDE_API_KEY` | |
| `together/` | `TOGETHER_API_KEY` | |
| `fireworks/` | `FIREWORKS_API_KEY` | |
| `groq/` | `GROQ_API_KEY` | |
| `cerebras/` | `CEREBRAS_API_KEY` | |
| `nvidia/` | `NVIDIA_API_KEY` | |
| `nebius/` | `NEBIUS_API_KEY` | |
| `hyperbolic/` | `HYPERBOLIC_API_KEY` | |
| `siliconflow/` | `SILICONFLOW_API_KEY` | |
| `deepinfra/` | `DEEPINFRA_API_KEY` | |
| `huggingface/` | `HUGGINGFACE_API_KEY` | |

(32 providers; azure is deferred until env-driven base URLs land.)

**Key invariants:**

- `AUTH_TOKENS` is the **gateway's own** auth — harnesses send `Authorization: Bearer <token>` or `x-api-key: <token>`. It is not an upstream provider key.
- Upstream provider keys are read from the env var named by `apiKeyEnv` for each provider in `src/config/providers.ts` (see table above). They are never forwarded to the client and never logged raw.
- `RELAY_AUTH_SECRET` must match the `x-relay-auth` your relay validates. All relay fetches are guarded by `isPrivateHostname` (blocks `localhost`, `127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, `fc`/`fd` ULA) and an `http:`/`https:` allowlist.
- No `.env` committed — `.env` and `.env.*` are gitignored. CI injects secrets via env vars.

**Generate a relay secret:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → 64-char hex string — paste into RELAY_AUTH_SECRET in .env and in the relay deployment
```

> **Dashboard dev note:** the frontend lives in `apps/web/` (Vite + React). Its dev server proxies
> `/v1` and `/health` to `http://localhost:8787`, so run the gateway on that port while working on
> the UI: `PORT=8787 pnpm dev`. In production the built SPA is served by Hono itself
> (`serveStatic` from `apps/web/dist`) — one binary, no separate web server.

---

## 4. Run

```bash
pnpm dev          # Hono + tsx watch — reloads on save
# —or—
bun run dev       # same, via Bun
```

Expected output:

```text
[lmntea-router] listening on http://localhost:3000
  POST /v1/chat/completions
  POST /v1/messages
  GET  /v1/models
  GET  /health
```

`/health` reports `"version":"0.2.0"`.

Sanity check:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.2.0"}

# authenticated probe — replace token with one entry from AUTH_TOKENS
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-lmntea-dev-1" | jq '.data | length'
# e.g. 114  (static registry count — more appear once OpenRouter intelligence sync enriches /v1/models)

# without auth when AUTH_TOKENS is set → 401
curl http://localhost:3000/v1/models
# {"error":{"type":"authentication_error","message":"..."}}
```

### Harness quick test (streaming)

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lmntea-dev-1" \
  -d '{
    "model": "opencode/x-preview-f-free",
    "messages": [{"role":"user","content":"Say hi in one sentence."}],
    "max_tokens": 256,
    "stream": true
  }'
# expect: data: {"choices":[{"delta":{"content":"Hi"}}]} … data: [DONE]

# Anthropic shape
curl -N http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-lmntea-dev-1" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"Say hi in one sentence."}]
  }'
```

---

## 5. Tests

```bash
pnpm test                        # 40 files, 568 tests — no ports, no real network
env -u AUTH_TOKENS pnpm test     # hermetic CI gate — must pass with secrets stripped
pnpm run test:watch              # watch mode
pnpm run test:coverage           # coverage report (threshold 85% — enforced in vitest.config.ts)
pnpm run test:e2e                # hermetic end-to-end smoke via app.request() (tests/e2e/smoke.test.ts)
```

Tests never hit real upstreams — unit/integration mocks `fetch` per test; the e2e smoke runs in-memory too.

Test style — in-memory HTTP, no `server.listen()`:

```ts
import { app } from '@/index.js';

test('clamps max_tokens to model ceiling', async () => {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-key' },
    body: JSON.stringify({
      model: 'opencode/x-preview-f-free',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 200_000,
    }),
  });
  expect(res.status).toBe(200);
});
```

### Lint & typecheck & build

```bash
pnpm run lint:fix          # Biome format + lint (auto-fix)
pnpm exec biome check .    # check only
pnpm exec tsc --noEmit     # types
pnpm run build             # tsup → dist/index.js ~190 KB (+ sourcemap + d.ts)
pnpm run check             # biome + tsc (CI gate)
pnpm run start             # node dist/index.js (after build)
```

Build config (`tsup.config.ts`): `src/index.ts` → `esm` + `dts` + `sourcemap`, `target: es2022`, `splitting: false`.

See `docs/ARCHITECTURE.md` for the module map and 6-stage pipeline.

---

## 6. Where to Add a New Provider — Checklist

Adding a provider (e.g., a new OpenAI-compatible endpoint or a Gemini/Anthropic-shaped one) is a **4-step cutover** — follow in order, no shims.

### Step 1 — Registry entry (`src/config/models.ts` + `src/config/providers.ts`)

**Preferred:** generate the entries with the importer in append-only `--merge` mode (idempotent,
skips placeholders, never rewrites existing entry bodies):

```bash
pnpm exec tsx scripts/import-provider.ts --provider example --source all --dry-run  # preview
pnpm exec tsx scripts/import-provider.ts --provider example --source all --merge    # append-only write
```

**Manual alternative** — one entry per model id you will route to:
```ts
// src/config/models.ts — one entry per model id you will route to
'example/new-model': {
  id: 'example/new-model',
  contextWindow: 131072,
  maxOutputTokens: 32768,          // exact upstream ceiling — not a guess
  stripParams: ['temperature'],    // if provider rejects sampling on reasoning variants
  requiresThinkingReconciliation: false,
},

// src/config/providers.ts — base URL + key env + relay tier
'example': {
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'EXAMPLE_API_KEY',
  relayPool: 'RELAY_POOL_URLS',    // or omit for direct-only
},
```

Also add any new env var to `.env.example` with a comment and a safe default.

### Step 2 — Translator branch (`src/translator/`)

- **OpenAI-compatible** JSON: no new translator — the existing `openai-to-*` path handles it; just set `stripParams` correctly.
- **Anthropic Messages** (`system` top-level, `tool_result` adjacency): extend `src/translator/openai-to-claude.ts` — reuse `sanitize.ts` + `tools.ts` (`enforceToolResultAdjacency`, orphan repair).
- **Gemini `generateContent`** (`systemInstruction`, `thought: true`): extend `src/translator/openai-to-gemini.ts` — ensure consecutive same-role merge and `thoughtSignature` handling.
- **Reasoning:** touch `src/normalizer/thinking.ts` — map `reasoning_effort` ↔ `budget_tokens` and reconcile `max_tokens > budget + 1024`.

Every translator is a **pure function** — input JSON → output JSON, no I/O. Add unit tests alongside.

### Step 3 — Relay / transport map (`src/router/transport.ts`)

- **Vercel relay pool** (fast, <25 s): add host to the relay allowlist; `proxyFetch` sends `x-relay-auth` + `x-relay-target` with `isPrivateHostname` guard.
- **Long-context** (>60 s reasoning): mark for the VPS/direct tier so it bypasses the 25 s relay watchdog (`RELAY_TIMEOUT_MS = 25_000`).
- No code change if an existing tier already fits — just configure the model entry to select the right tier via `providers.ts`.

### Step 4 — Tests (`vitest` — no project-wide build needed)

```bash
pnpm test tests/translator/openai-to-claude.test.ts
pnpm test tests/normalizer/clamp.test.ts
pnpm test tests/router/circuitBreaker.test.ts
```

Required coverage for a new provider PR:

- [ ] **Clamp test** — `max_tokens: 999999` clamps to the provider's ceiling
- [ ] **Sanitize test** — unsupported params are stripped (e.g., `temperature` on reasoning models)
- [ ] **Translation test** — OpenAI → provider wire shape round-trips (messages, tools, system, media parts)
- [ ] **Tool adjacency test** — `assistant(tool_calls) → user(tool_result)` adjacency holds; orphans degrade to user text
- [ ] **Integration test** — `app.request('/v1/chat/completions', { model: 'your/new-model' })` returns `200` with mocked upstream (no real key needed)

Open the PR with: registry diff + translator diff + transport tier note + test evidence.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Bun not found` | Bun not installed | Install from https://bun.sh or use `pnpm run dev:node` via Node 20 + `tsx` |
| `401 Unauthorized` on local curl | Wrong `AUTH_TOKENS` | Ensure `Authorization: Bearer <token>` matches one comma-separated entry in `AUTH_TOKENS` |
| `400 max_tokens illegal: [1,131072]` | New model missing clamp entry | Add `maxOutputTokens` ceiling in `src/config/models.ts` |
| `504 FUNCTION_INVOCATION_TIMEOUT` via relay | Generation >25 s on Vercel | Route that model via direct/VPS tier in `src/router/transport.ts` |
| Stream hangs, no `: keepalive` | Upstream slow but keepalive not wired | Verify `withEarlyKeepalive` wraps the dispatch in `src/index.ts` |
| Tests fail locally but pass in CI | `.env` sets `AUTH_TOKENS`, changing auth behavior | Run the hermetic gate: `env -u AUTH_TOKENS pnpm test` |

---

## Further Reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — request pipeline, module map, invariants, phases P0–P6
- [`docs/README.md`](./README.md) — landing page, quick start, `curl` examples
- `.env.example` — authoritative env defaults
