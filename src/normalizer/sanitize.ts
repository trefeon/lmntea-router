import type { ModelSpec } from '../config/models.js'

const BASE_ALLOWLIST: Record<string, true> = {
  model: true,
  messages: true,
  max_tokens: true,
  max_completion_tokens: true,
  stream: true,
  tools: true,
  tool_choice: true,
  temperature: true,
  top_p: true,
  n: true,
  stop: true,
  presence_penalty: true,
  frequency_penalty: true,
}

export function sanitizeParams(
  body: Record<string, unknown>,
  spec: ModelSpec,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body }

  for (const k of spec.stripParams) {
    delete copy[k]
  }

  if (spec.supportedParams.size > 0) {
    for (const k of Object.keys(copy)) {
      if (!spec.supportedParams.has(k) && !BASE_ALLOWLIST[k]) {
        delete copy[k]
      }
    }
  }

  return copy
}
