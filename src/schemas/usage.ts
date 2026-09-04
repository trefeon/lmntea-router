import { z } from 'zod'

export const UsageQuerySchema = z
  .object({
    period: z.enum(['24h', '7d', '30d']),
  })
  .strict()

export type UsageQuery = z.infer<typeof UsageQuerySchema>
