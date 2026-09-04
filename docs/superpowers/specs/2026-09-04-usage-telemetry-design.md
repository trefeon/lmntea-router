# Usage Telemetry Design

## Problem

The dashboard's Usage page currently falls back to fabricated sample metrics because lmntea-router exposes no usage endpoint. The router has real request lanes but no bounded request telemetry.

## Decision

Add a process-local, bounded usage recorder and expose an authenticated `GET /v1/usage` endpoint. Record gateway outcomes from the existing Chat Completions and Anthropic Messages lanes without changing routing, normalization, translation, or streaming behavior.

The recorder stores at most 10,000 records and aggregates in memory for `24h`, `7d`, and `30d`. It does not store request bodies, API keys, or raw upstream payloads. Restarting the process clears the data; separate processes do not share it.

## Contract

```ts
export type UsagePeriod = '24h' | '7d' | '30d'

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
  points: Array<{ t: string; requests: number; tokens: number | null }>
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

`GET /v1/usage?period=24h|7d|30d` returns `200 application/json` with `UsageSummary`. Invalid or missing periods return the existing `422 invalid_request_error` envelope with `code: INVALID_REQUEST`. The existing `/v1` auth middleware protects the route. Empty periods return zero requests/errors, empty arrays, and `null` for unavailable measurements.

`errors` counts HTTP status `>= 400`. `avgLatencyMs` and `p95Ms` describe gateway response completion latency. Token, cost, cache, and TTFT fields are `null` until a route observes those values; zero must not mean unknown.

## Recording Boundary

A small middleware runs around only the two request lanes. Each route sets the parsed model in the request context. After the route resolves, middleware records the response status and elapsed gateway time. Parse/auth failures that occur before the route context do not create model records. The recorder must not affect response status, headers, body, abort propagation, breaker state, or stream composition.

Current stream responses expose status and headers before the body finishes. The first implementation records the HTTP response lifecycle latency available at the middleware boundary and does not claim final generation success or TTFT. Future stream-finalization work can add richer attempt telemetry without changing this contract.

## Frontend Behavior

`fetchUsage` returns the real endpoint result or throws; it never returns `MOCK_USAGE`. The Usage page keeps period selection and CSV export, renders an empty state for a zero-record summary, and renders `—` for nullable metrics. It must not label data as mock or show invented request, token, cost, cache, or latency values.

## Reference Influence

`reference/freellmapi` informed the aggregate-first direction: update a compact summary at write time and read dashboard totals from aggregates so later persistence can prune raw events safely. Its Express, SQLite, quota-bandit, backup, and multi-process machinery are intentionally excluded from this slice.

## Acceptance Criteria

- Real Chat Completions and Messages requests increment the usage summary.
- Success and error HTTP statuses are counted accurately.
- Results are grouped by model and period-filtered.
- Empty usage is honest and deterministic.
- The ring never exceeds 10,000 records.
- `/v1/usage` has the standard auth and validation behavior.
- Existing route tests remain green; focused usage tests cover the contract.
- No fabricated metrics remain in the Usage client/page fallback path.
