export type UsagePeriod = '24h' | '7d' | '30d'

export const USAGE_PERIODS = ['24h', '7d', '30d'] as const

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

const MAX_RECORDS = 10_000
const PERIOD_MS: Record<UsagePeriod, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const records: UsageRecord[] = new Array(MAX_RECORDS)
let start = 0
let size = 0

export function recordUsage(record: UsageRecord): void {
  const entry: UsageRecord = { ...record, at: record.at ?? Date.now() }
  const index = (start + size) % MAX_RECORDS
  records[index] = entry
  if (size < MAX_RECORDS) {
    size += 1
  } else {
    start = (start + 1) % MAX_RECORDS
  }
}

export function summarizeUsage(
  period: UsagePeriod,
  now = Date.now(),
): UsageSummary {
  const cutoff = now - PERIOD_MS[period]
  let requests = 0
  let errors = 0
  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
  let tokenInCount = 0
  let tokenOutCount = 0
  let costCount = 0
  let ttftTotal = 0
  let ttftCount = 0
  let cacheHits = 0
  let cacheCount = 0
  let latencyTotal = 0
  const latencies: number[] = []
  const points = new Map<number, { requests: number; tokens: number | null }>()
  const models = new Map<string, ModelAggregate>()

  for (let offset = 0; offset < size; offset += 1) {
    const record = records[(start + offset) % MAX_RECORDS]
    if (record === undefined || (record.at as number) < cutoff) continue

    requests += 1
    if (record.status >= 400) errors += 1
    latencyTotal += record.durationMs
    latencies.push(record.durationMs)

    if (record.tokensIn !== undefined) {
      tokensIn += record.tokensIn
      tokenInCount += 1
    }
    if (record.tokensOut !== undefined) {
      tokensOut += record.tokensOut
      tokenOutCount += 1
    }
    if (record.cost !== undefined) {
      cost += record.cost
      costCount += 1
    }
    if (record.ttftMs !== undefined) {
      ttftTotal += record.ttftMs
      ttftCount += 1
    }
    if (record.cacheHit !== undefined) {
      if (record.cacheHit) cacheHits += 1
      cacheCount += 1
    }

    const hour = Math.floor((record.at as number) / 3_600_000) * 3_600_000
    const point = points.get(hour)
    const tokenValue = (record.tokensIn ?? 0) + (record.tokensOut ?? 0)
    if (point === undefined) {
      points.set(hour, {
        requests: 1,
        tokens:
          record.tokensIn !== undefined || record.tokensOut !== undefined
            ? tokenValue
            : null,
      })
    } else {
      point.requests += 1
      if (
        point.tokens !== null ||
        record.tokensIn !== undefined ||
        record.tokensOut !== undefined
      ) {
        point.tokens = (point.tokens ?? 0) + tokenValue
      }
    }

    let model = models.get(record.model)
    if (model === undefined) {
      model = {
        req: 0,
        tokens: null,
        ttftTotal: 0,
        ttftCount: 0,
        cost: null,
      }
      models.set(record.model, model)
    }
    model.req += 1
    if (record.tokensIn !== undefined || record.tokensOut !== undefined) {
      model.tokens = (model.tokens ?? 0) + tokenValue
    }
    if (record.ttftMs !== undefined) {
      model.ttftTotal += record.ttftMs
      model.ttftCount += 1
    }
    if (record.cost !== undefined) model.cost = (model.cost ?? 0) + record.cost
  }

  latencies.sort((left, right) => left - right)
  const p95Ms =
    requests === 0
      ? null
      : (latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null)
  const byModel = [...models.entries()]
    .sort(([left, a], [right, b]) => b.req - a.req || left.localeCompare(right))
    .map(([model, aggregate]) => ({
      model,
      req: aggregate.req,
      tokens: aggregate.tokens,
      share: requests === 0 ? 0 : (aggregate.req / requests) * 100,
      ttftMs:
        aggregate.ttftCount === 0
          ? null
          : aggregate.ttftTotal / aggregate.ttftCount,
      cost: aggregate.cost,
    }))

  const pointValues = [...points.entries()].sort(
    ([left], [right]) => left - right,
  )
  return {
    requests,
    errors,
    tokensIn: tokenInCount === 0 ? null : tokensIn,
    tokensOut: tokenOutCount === 0 ? null : tokensOut,
    cost: costCount === 0 ? null : cost,
    avgLatencyMs: requests === 0 ? null : latencyTotal / requests,
    avgTtftMs: ttftCount === 0 ? null : ttftTotal / ttftCount,
    p95Ms,
    cacheHit: cacheCount === 0 ? null : cacheHits / cacheCount,
    points: pointValues.map(([timestamp, point]) => ({
      t: new Date(timestamp).toISOString(),
      ...point,
    })),
    byModel,
  }
}

export function resetUsageForTests(): void {
  records.fill(undefined as never)
  start = 0
  size = 0
}

type ModelAggregate = {
  req: number
  tokens: number | null
  ttftTotal: number
  ttftCount: number
  cost: number | null
}
