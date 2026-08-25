import { z } from 'zod'

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(z.any()).min(1, 'messages is required'),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>
