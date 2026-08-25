import type { ModelSpec } from '../config/models.js'

const effortMap: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 32768,
  max: 131072,
  xhigh: 131072,
  none: 0,
}

export function reconcileThinking(
  body: Record<string, unknown>,
  spec: ModelSpec,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body }

  let budget: number | undefined

  const thinkingRaw = copy.thinking
  if (
    thinkingRaw !== null &&
    typeof thinkingRaw === 'object' &&
    typeof thinkingRaw !== 'undefined' &&
    'budget_tokens' in thinkingRaw
  ) {
    // validated object shape via 'in' check — safe to read property
    const rec = thinkingRaw as Record<string, unknown>
    const candidate = rec.budget_tokens
    if (typeof candidate === 'number') {
      budget = candidate
    }
  }

  if (budget === undefined && typeof copy.reasoning_effort === 'string') {
    const mapped = effortMap[copy.reasoning_effort]
    if (mapped !== undefined) {
      budget = mapped
      if (copy.thinking === undefined) {
        copy.thinking = { budget_tokens: mapped }
      }
    }
  }

  if (budget === undefined || budget === 0) {
    return copy
  }

  const shouldReconcile = spec.requiresThinkingReconciliation || budget > 0
  if (!shouldReconcile) {
    return copy
  }

  const rawMax = copy.max_tokens
  const currentMax: number =
    typeof rawMax === 'number' ? rawMax : spec.maxOutputTokens

  const required = budget + 1024
  const next = Math.max(currentMax, required)
  copy.max_tokens = next

  return copy
}
