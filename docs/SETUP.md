# Setup — lmntea-router

> **Time:** <5 minutes from zero to `curl` 200.
> **Stack (decided):** `TypeScript 5.6 + Hono 4.x + Bun 1.2 (Node 20 fallback) + Vitest 2.x + Zod 3.x + tsup + tsx + Biome + pnpm`

This guide is for a new human contributor **or** an AI agent bootstrapping the repo locally. Every command is copy-pasteable on Windows (Git Bash / PowerShell), macOS, and Linux. For the request pipeline and module map see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Prerequisites

| Requirement | Version | Check | Notes |
|---|---|---|---|
| **Bun** (preferred) | `1.2+` | `bun --version` | Primary runtime — Hono + Web Streams natively. https://bun.sh |
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

**Key invariants:**

- `AUTH_TOKENS` is the **gateway's own** auth — harnesses send `Authorization: Bearer <token>` or `x-api-key: <token>`. It is not an upstream provider key.
- Upstream provider keys (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) live only in `src/config/providers.ts` and are never forwarded to the client.
- `RELAY_AUTH_SECRET` must match the `x-relay-auth` your relay validates. All relay fetches are guarded by `isPrivateHostname` (blocks `localhost`, `127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, `fc`/`fd` ULA) and an `http:`/`https:` allowlist.
- No `.env` committed — `.env` and `.env.*` are gitignored. CI injects secrets via env vars.

**Generate a relay secret:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → 64-char hex string — paste into RELAY_AUTH_SECRET in .env and in the relay deployment
```

---

## 4. Run

```bash
pnpm dev          # Hono + tsx watch — reloads on save
# —or—
bun run dev       # same, via Bun
```

Expected output:

```
[lmntea-router] listening on http://localhost:3000
  POST /v1/chat/completions
  POST /v1/messages
  GET  /v1/models
  GET  /health
```

Sanity check:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.1.0"}

# authenticated probe — replace token with one entry from AUTH_TOKENS
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-lmntea-dev-1" | jq '.data | length'
# e.g. 8  (static registry count — enriched when intelligence sync is on)

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
pnpm test           # 21 suites, 327 tests — no ports, no real network
pnpm run test:watch # watch mode
pnpm run test:coverage  # coverage report (threshold 85% — enforced in vitest.config.ts)
```

With real upstream keys (opt-in, never in CI):

```bash
E2E=1 pnpm test     # enables live upstream probes when provider keys are set
```

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
pnpm run build             # tsup → dist/index.js ~60 KB + dist/index.js.map ~160 KB + dist/index.d.ts 370 B
pnpm run check             # biome + tsc (CI gate)
pnpm run start             # node dist/index.js (after build)
```

Build config (`tsup.config.ts`): `src/index.ts` → `esm` + `dts` + `sourcemap`, `target: es2022`, `splitting: false`.

See `docs/ARCHITECTURE.md` for the module map and 6-stage pipeline.

---

## 6. Where to Add a New Provider — Checklist

Adding a provider (e.g., a new OpenAI-compatible endpoint or a Gemini/Anthropic-shaped one) is a **4-step cutover** — follow in order, no shims.

### Step 1 — Registry entry (`src/config/models.ts` + `src/config/providers.ts`)

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
pnpm test src/translator/openai-to-claude.test.ts
pnpm test src/normalizer/clamp.test.ts
pnpm test src/router/circuitBreaker.test.ts
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
| `E2E=1` tests still mock | No real provider keys in env | Set the relevant `*_API_KEY` in `.env`; `E2E=1` only enables live probes when keys exist |

---

## Further Reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — request pipeline, module map, invariants, phases P0–P6
- [`docs/README.md`](./README.md) — landing page, quick start, `curl` examples
- `.env.example` — authoritative env defaults
