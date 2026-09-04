import type { Hono } from 'hono'
import { validationError } from '../middleware/errors.js'
import { summarizeUsage } from '../observability/usage.js'
import { UsageQuerySchema } from '../schemas/usage.js'
import type { Env } from '../types.js'

export function mountUsage(app: Hono<Env>) {
  app.get('/v1/usage', (c) => {
    const parsed = UsageQuerySchema.safeParse({
      period: c.req.query('period'),
    })
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return validationError(c, first?.message ?? 'Invalid period', 'period')
    }

    return c.json(summarizeUsage(parsed.data.period))
  })
}
