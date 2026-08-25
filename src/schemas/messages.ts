import { z } from 'zod'

export const MessagesRequestSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(z.any()).min(1, 'messages is required'),
    max_tokens: z.number().int().positive(),
    system: z.any().optional(),
    tools: z.array(z.any()).optional(),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type MessagesRequest = z.infer<typeof MessagesRequestSchema>
