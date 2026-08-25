# Pull Request

## Summary

<!-- One-line: what this PR does and which phase (P0–P6) it belongs to -->

## Research refs

<!-- Cite the research spec that justifies every limit/behavior. Required for numeric ceilings. -->
<!-- e.g. research/per_model_failure_analysis.md §3 (maxOutput 131072 for opencode/x-preview-f-free) -->
<!-- e.g. research/universal_protocol_translation_spec.md §4.2 (effort→budget table) -->
- [ ] Cited `research/` doc + section for every clamp/limit/behavior:

## Provider cutover — 4-step checklist (devdocs/SETUP.md §6)

> Complete in order. Delete this section if the PR does not add a provider.

### Step 1 — Registry (`src/config/models.ts` + `src/config/providers.ts`)

- [ ] Added `ModelSpec` entry with exact `contextWindow` / `maxOutputTokens` (not a guess)
- [ ] Set `stripParams` / `supportedParams` correctly (e.g. strip `temperature` on reasoning variants)
- [ ] Set `requiresThinkingReconciliation` if reasoning/thinking involved
- [ ] Added provider entry in `src/config/providers.ts` (baseUrl, apiKeyEnv, relay flag)
- [ ] Added new env var to `.env.example` with comment + safe default

### Step 2 — Translator (`src/translator/`)

- [ ] No new translator if OpenAI-compatible (existing `openai-to-*` path handles it via `stripParams`)
- [ ] Anthropic shape: extended `openai-to-claude.ts` + reused `sanitize.ts` / `tools.ts` (`enforceToolResultAdjacency`)
- [ ] Gemini shape: extended `openai-to-gemini.ts` (consecutive same-role merge, `thoughtSignature` caching)
- [ ] Reasoning: touched `src/normalizer/thinking.ts` (effort→budget map per `universal_protocol_translation_spec.md` §4.2, reconcile `max_tokens > budget + 1024`)
- [ ] Translator is pure function (input JSON → output JSON, no I/O)

### Step 3 — Relay / transport (`src/router/transport.ts`)

- [ ] Relay tier chosen: Vercel pool (<20 s, 25 s watchdog `RELAY_TIMEOUT_MS`) vs direct/VPS (>60 s reasoning)
- [ ] `x-relay-auth` + `isPrivateHostname` guard preserved
- [ ] No direct URL leak when relay succeeds

### Step 4 — Tests (Vitest, no live network)

- [ ] **Clamp test** — `max_tokens: 999999` clamps to provider ceiling (e.g. 32768 / 131072 / 200000)
- [ ] **Sanitize test** — unsupported params stripped, input not mutated (shallow copy asserted)
- [ ] **Translation test** — OpenAI → provider wire shape round-trips (messages, tools, system, media)
- [ ] **Tool adjacency test** — `assistant(tool_calls) → user(tool_result)` holds; orphans degrade to user text
- [ ] **Integration test** — `app.request('/v1/chat/completions', { model: 'your/new-model' })` returns 200 with mocked upstream
- [ ] Registry diff + translator diff + transport tier note + test evidence included in PR description
- [ ] Linked `research/` doc that justifies the clamp value

## Exit criteria — `devdocs/02-ROADMAP.md`

> Check the phase that applies. All boxes must be green before merge.

### Cross-phase invariants (every PR)

- [ ] `pnpm test` green on Node 20 (and Bun 1.2 if applicable)
- [ ] `pnpm lint` (`biome check`) and `pnpm typecheck` (`tsc --noEmit`) green, `pnpm build` (`tsup`) succeeds
- [ ] No file outside canonical module tree without ADR (`devdocs/02-ROADMAP.md` §2)
- [ ] No hardcoded model limits — every ceiling from `src/config/models.ts` or intelligence cache
- [ ] Every error response is JSON `{ error: { type, message, param? } }` with `x-request-id`
- [ ] Streaming never throws unhandled `TransferEncodingError` / `AbortError`
- [ ] Secrets never logged; `x-relay-auth` never echoed

### Phase-specific gates

<!-- Check one -->

- [ ] **P0 Bootstrap** — `pnpm dev` + `curl /health` 200, `pnpm test` ≥1 (health), `docker build` succeeds, fresh clone → `cp .env.example .env && pnpm install && pnpm test` works
- [ ] **P1 Ingress** — auth matrix ≥8 cases (Bearer / x-api-key / anthropic-api-key + precedence + /health exempt), 415 guard ≥3, 413 limit ≥3, 422 validation shape, stubs only (no normalizer leak)
- [ ] **P2 Normalizer** — 6 failure models replay exact error payloads and assert clamp/sanitize prevents them; boundaries `limit`, `limit±1`, `0`, `undefined`; `pnpm test` ≥30 normalizer assertions; `sanitizeParams` pure (no mutation); no `any` in `src/normalizer/**`
- [ ] **P3 Translator** — every case in `universal_protocol_translation_spec.md` §2 / §3.2 / §4.2 / §4.3 / §5.1 has a test; round-trip `OpenAI→Claude→OpenAI` + `OpenAI→Gemini→OpenAI` preserves IDs; Gemini wire has no consecutive same-role turns
- [ ] **P4 Streaming** — `earlyKeepalive` 2 s ping verified with fake timers; `stallWatchdog` 60 s reset-on-chunk + synthesized finish; `AbortController` propagates client disconnect; no `unhandledRejection`
- [ ] **P5 Router & Relay** — `504`/`FUNCTION_INVOCATION_TIMEOUT` → 25 s abort + failover (mocked fetch `advanceTimersByTime(25000)`); breaker trips only after `AllowedFailsPolicy` (3× 5xx / 60 s); least-busy picks `argmin(in_flight)`; `isPrivateHostname` blocks 10./192.168./127.0.0.1/169.254.169.254
- [ ] **P6 Intelligence** — `GET /v1/models` enriched (context, modalities, pricing, intelligence, value); ValueScore at tier boundaries (45/75) tested; AA down → OpenRouter alone still works; `GET /` dashboard stub renders

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

<!-- Paste or summarize relevant test output. For provider PRs, show clamp/sanitize/adjacency assertions. -->

## Checklist

- [ ] Title follows `feat:`, `fix:`, `chore:` convention and references phase (e.g. `feat(p2): clamp opencode/laguna`)
- [ ] No `.env` or secret committed
- [ ] `pnpm-lock.yaml` updated if deps changed (`pnpm install --frozen-lockfile` passes)
