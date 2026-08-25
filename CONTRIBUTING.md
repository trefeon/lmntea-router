# Contributing to lmntea-router

Thanks for contributing — every change should keep the gateway boring, sharp, and under 2,500 LOC.

> **Stack:** `TypeScript 5.6 + Hono 4.x + Bun 1.2 (Node 20 fallback) + Vitest 2.x + Zod 3.x + tsup + tsx + Biome + pnpm`

---

## 1. Dev Setup (< 5 min)

### Prerequisites

| Requirement | Version | Check | Notes |
|---|---|---|---|
| **Bun** (preferred) | `1.2+` | `bun --version` | Primary runtime — Hono + Web Streams natively |
| **Node** (fallback) | `20+` | `node --version` | Used if Bun is unavailable; `tsx` provides the same dev loop |
| **pnpm** | `9+` | `pnpm --version` | CI uses `pnpm`; `npm`/`yarn` work but not tested in CI |
| **Git** | any | `git --version` | |

No Docker, no database, no external service required — the gateway runs in-memory with a static `MODEL_REGISTRY` fallback when intelligence sync is disabled.

### Clone, install, configure, run

```bash
# 1. Clone
git clone https://github.com/trefeon/lmntea-router.git
cd lmntea-router

# 2. Install
pnpm install

# 3. Configure
cp .env.example .env
# edit .env — see docs/SETUP.md for the env table
# minimum: set AUTH_TOKENS to a value you will send as Authorization: Bearer ...

# 4. Run (hot reload, ~10 ms boot)
pnpm dev
# → [lmntea-router] listening on http://localhost:3000
```

Available dev scripts:

| Script | Command | Notes |
|---|---|---|
| `pnpm dev` | `bun --watch src/index.ts` | Primary — Bun watch |
| `pnpm run dev:node` | `tsx watch src/index.ts` | Node fallback |
| `pnpm build` | `tsup src/index.ts --format esm --dts --clean` | Produces `dist/` |
| `pnpm run check` | `biome check . && tsc --noEmit` | Lint + typecheck |
| `pnpm test` | `vitest run` | Unit + integration (no ports) |

### Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.1.0"}

# authenticated probe (replace with your AUTH_TOKENS value)
curl http://localhost:3000/v1/models -H "Authorization: Bearer sk-lmntea-dev-1"
```

If `AUTH_TOKENS` is empty, `GET /v1/models` and `/v1/chat/completions` are unauthenticated (hermetic mode for tests). With `AUTH_TOKENS` set, every `/v1/*` route requires `Authorization: Bearer <token>` or `x-api-key`.

---

## 2. Branch Naming

| Prefix | Use for |
|---|---|
| `feat/<slug>` | New feature (e.g., `feat/gemini-thought-signature`) |
| `fix/<slug>` | Bug fix (e.g., `fix/clamp-overflow`) |
| `docs/<slug>` | Docs only (e.g., `docs/setup-env-table`) |
| `chore/<slug>` | Tooling, deps, CI (e.g., `chore/bump-hono-4-7`) |
| `refactor/<slug>` | Internal restructure, no behavior change |

Keep branches short-lived and rebased on `main`. Avoid `main` → `main` pushes.

---

## 3. Commit Convention

Conventional Commits — required for changelog and review:

```
<type>(<scope>): <subject>

[body]

[footer]
```

- **type:** `feat` | `fix` | `docs` | `chore` | `refactor` | `test` | `perf` | `ci`
- **scope:** optional module (`normalizer`, `translator`, `streaming`, `router`, `config`, `intelligence`)
- **subject:** imperative, lowercase, no period, ≤72 chars
- **body:** why, not what — cite `research/` or `reference/` when the clamp/translator value comes from prior art

Examples:

```
feat(translator): add Gemini thoughtSignature caching

fix(normalizer): clamp max_tokens to maxOutputTokens for kimi-k2

docs: align env table with .env.example (AUTH_TOKENS)
```

---

## 4. PR Process

1. **Branch** from `main` with the naming above.
2. **Code** — follow the canonical module tree in `docs/ARCHITECTURE.md` (same tree as `src/`). Don't invent a new top-level folder without an ADR.
3. **Test** — `pnpm test` must pass. New behavior needs a test (see `docs/SETUP.md` § Testing). Translators are pure functions — test input JSON → output JSON, no network.
4. **Lint & typecheck** — `pnpm run check` (Biome + `tsc --noEmit`) must be green. Run `pnpm run lint:fix` to auto-fix.
5. **Docs** — if you add a model, provider, or env var, update `docs/SETUP.md` env table and `.env.example` (same names, same defaults).
6. **Open PR** against `main`:
   - Title follows commit convention.
   - Description: what, why, and test evidence (`pnpm test` output or a `curl` transcript). Link the `research/` or `reference/` source if the change ports a known pattern.
   - Keep PRs focused — one provider or one pillar per PR.
7. **Review** — address comments, keep the branch rebased. Squash-merge is default.
8. **CI** — GitHub Actions runs `check` + `test` + `build:check` on every PR. Green CI is required to merge.

### Adding a provider

Follow the 4-step checklist in `docs/SETUP.md` § "Where to Add a New Provider" — registry → translator → transport tier → tests. Open the PR with all four steps done; no shims.

---

## 5. Where to Find Docs

| Doc | What it is |
|---|---|
| [`docs/README.md`](docs/README.md) | Landing page, quick start, `curl` examples, project structure |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Request pipeline diagram, module map, invariants, phases P0–P6 |
| [`docs/SETUP.md`](docs/SETUP.md) | Prerequisites, env table, run & test, provider checklist, troubleshooting |
| `.env.example` | Authoritative env defaults — keep in sync with `docs/SETUP.md` |
| `src/config/models.ts` | Model registry (contextWindow, maxOutputTokens) |
| `src/config/providers.ts` | Provider endpoints, key pools, relay pool, SSRF guard |

Private deep dives (`devdocs/`, `research/`, `reference/`) are gitignored and absent in a public clone — that's expected. `docs/ARCHITECTURE.md` is the self-contained public overview.

---

## 6. Code Style

- **Formatter & linter:** Biome (`pnpm run lint:fix`). Don't fight it — run it before pushing.
- **Types:** strict `tsc --noEmit` must pass. No `any` without a `// biome-ignore` + justification.
- **Translators & normalizers:** pure functions, deterministic, unit-testable without I/O.
- **Streaming:** never swallow mid-stream errors — emit SSE error event + `[DONE]`.
- **Security:** never log raw keys — `AUTH_TOKENS` values are hashed at rest; use masked helpers.

---

## 7. Reporting Issues

- **Bug:** open an issue with repro (`curl` or `app.request()` snippet), expected vs actual, and `pnpm test` output if relevant.
- **Security:** do not open a public issue — email the maintainers directly (see `SECURITY.md` if present).
- **Question:** open a discussion or issue with the `question` label.

---

<p align="center"><sub>Built for coding agents. Boring infra, sharp edges removed.</sub></p>
