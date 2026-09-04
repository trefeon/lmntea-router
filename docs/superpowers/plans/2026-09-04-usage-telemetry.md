# Usage Telemetry Implementation Plan

> **For agentic workers:** implement this plan task-by-task with focused tests and verification.

**Goal:** Replace the dashboard's fabricated Usage fallback with real, bounded, authenticated request telemetry from lmntea-router.

**Architecture:** Add a process-local bounded ring of request outcomes. Route middleware records the HTTP result and gateway latency for the two real request lanes; the recorder aggregates by period and model without inventing token, cost, cache, or TTFT values. `GET /v1/usage` exposes the aggregate to the existing dashboard. Persistence and multi-process aggregation remain out of scope.

**Tech Stack:** TypeScript 5.9 strict, Hono 4.x, Zod 3.x, Bun/Node, Vitest `app.request()`, React 19 + Vite frontend.

**Spec:** The approved 2026-09-04 usage slice: real request/error counts and gateway latency; nullable fields when upstream telemetry is unavailable; `24h|7d|30d`; no mock fallback.

## Global Constraints

- Keep Hono + Zod + Bun/Node; add no runtime dependency.
- Preserve existing route behavior, router decisions, streaming composition, auth, and response bodies.
- Usage route is protected by existing `/v1` auth middleware.
- Store at most `10_000` events in process memory; restart clears telemetry.
- `tokensIn`, `tokensOut`, `cost`, `avgTtftMs`, and `cacheHit` are `null` until an observed event supplies those values.
- `p95Ms` and `avgLatencyMs` describe gateway response latency, not upstream TTFT.
- Tests use `app.request()` and stub upstream fetch; no network or TCP listeners.
- Do not expose API keys or raw request bodies in telemetry.

## Contract

```ts
export type UsagePeriod = "24h" | "7d" | "30d"

export type UsageRecord = {
  at?: number
  model: string
  status: number
  durationMs: number
  tokensIn?: number
  tokensOut?: number
  cost?: number
  ttftMs?: number
  cacheHit?: boolean
}

export type UsagePoint = {
  t: string
  requests: number
  tokens: number | null
}

export type UsageSummary = {
  requests: number
  errors: number
  tokensIn: number | null
  tokensOut: number | null
  cost: number | null
  avgLatencyMs: number | null
  avgTtftMs: number | null
  p95Ms: number | null
  cacheHit: number | null
  points: UsagePoint[]
  byModel: Array<{
    model: string
    req: number
    tokens: number | null
    share: number
    ttftMs: number | null
    cost: number | null
  }>
}
```

## File Map

- Create `src/observability/usage.ts`: bounded ring, `recordUsage`, `summarizeUsage`, `resetUsageForTests`.
- Create `src/middleware/usage.ts`: record route status/model/latency after `next()`.
- Create `src/routes/usage.ts`: validate period and return `UsageSummary`.
- Modify `src/types.ts`: add the internal usage context variable.
- Modify `src/index.ts`: mount usage middleware on chat/messages and mount the usage route.
- Modify `src/routes/chat.ts` and `src/routes/messages.ts`: set the parsed model in usage context; no routing behavior changes.
- Create `tests/observability/usage.test.ts`: recorder aggregation, nullable metrics, period filtering, and ring bound.
- Create `tests/usage.test.ts`: route shape, auth, invalid period, and real chat/messages recording.
- Modify `apps/web/src/lib/api.ts`: remove `MOCK_USAGE`; make `fetchUsage` return the real endpoint or throw.
- Rewrite `apps/web/src/pages/Usage.tsx`: consume nullable summary fields, render honest empty/unknown states, and remove mock labels/fabricated fallback copy.

## Task Order

### Task 1: Recorder

1. Write failing unit tests for empty summaries, period filtering, model aggregation, nullable metrics, and the `10_000` event bound.
2. Implement the bounded ring and aggregate calculation.
3. Run the focused unit test file.

### Task 2: Backend Route

1. Write failing route tests for empty `GET /v1/usage`, period validation, auth, chat recording, and messages recording.
2. Add usage context + middleware + route wiring.
3. Set the parsed model in both real request lanes without changing their responses.
4. Run the focused route test file.

### Task 3: Frontend

1. Remove the `MOCK_USAGE` fallback and `fromMock` contract.
2. Update nullable metric rendering and request-latency labels.
3. Render zero/empty data as an honest empty state and avoid displaying unavailable metrics as zero.
4. Keep period selection and CSV export behavior for fields actually present.

### Checkpoint

- `bunx vitest run tests/observability/usage.test.ts tests/usage.test.ts`
- `bunx tsc --noEmit`
- `bunx biome check src apps/web/src tests`
- `bunx vite build` from `apps/web`
- Live `GET /v1/usage` through the running dev server returns the contract and starts empty after restart.

## Known Limits

- Process restart or a second process clears/separates telemetry.
- Current proxy streams expose response headers before body completion, so stream records measure gateway response latency and HTTP status, not final upstream generation success.
- Current upstream response paths do not expose usage tokens, pricing, cache hits, or TTFT; those fields remain `null` instead of zero or sample values.
- Provider, Proxy Pool, and Combo pages remain explicitly labeled static samples until backend contracts are added.
