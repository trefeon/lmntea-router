import type { ModelSpec } from '../config/models.js'

export function estimateInputTokens(
  messages: unknown,
  tools?: unknown,
): number {
  const s = JSON.stringify(messages ?? '') + JSON.stringify(tools ?? '')
  return Math.ceil(s.length / 4) || 1
}

export function clampBody(
  body: Record<string, unknown>,
  spec: ModelSpec,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body }
  const inputTokens = estimateInputTokens(body.messages, body.tools)
  const windowBudget = spec.contextWindow - inputTokens - 256
  const minOutput = spec.minOutputTokens ?? 1

  const computeEffective = (requested: unknown): number => {
    const req =
      typeof requested === 'number' && Number.isFinite(requested)
        ? requested
        : spec.maxOutputTokens
    return Math.max(
      Math.min(req, spec.maxOutputTokens, windowBudget),
      minOutput,
    )
  }

  const hasMaxTokens = copy.max_tokens !== undefined
  const hasMaxCompletion = copy.max_completion_tokens !== undefined

  if (hasMaxTokens) {
    copy.max_tokens = computeEffective(copy.max_tokens)
  }
  if (hasMaxCompletion) {
    copy.max_completion_tokens = computeEffective(copy.max_completion_tokens)
  }
  if (!hasMaxTokens && !hasMaxCompletion) {
    const eff = computeEffective(undefined)
    copy.max_tokens = Math.min(spec.maxOutputTokens, eff)
  }

  return copy
}
export const clampMaxTokens = clampBody
