import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from '../types.js'
import { getRequestId } from './requestId.js'

type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'not_found_error'

export function errorEnvelope(
  c: Context<Env>,
  status: ContentfulStatusCode,
  type: ErrorType,
  message: string,
  opts: { code?: string; param?: string | null } = {},
) {
  const requestId = getRequestId(c)
  const body: Record<string, unknown> = {
    error: {
      type,
      message,
      ...(opts.code ? { code: opts.code } : {}),
      ...(opts.param ? { param: opts.param } : {}),
    },
  }
  if (requestId) (body as Record<string, unknown>).request_id = requestId
  return c.json(body, status)
}

export const unauthorized = (c: Context<Env>, msg = 'API key required') =>
  errorEnvelope(c, 401, 'authentication_error', msg, { code: 'UNAUTHORIZED' })

export const unsupportedMediaType = (c: Context<Env>) =>
  errorEnvelope(
    c,
    415,
    'invalid_request_error',
    'Content-Type must be application/json',
    {
      code: 'UNSUPPORTED_MEDIA_TYPE',
    },
  )

export const payloadTooLarge = (c: Context<Env>) =>
  errorEnvelope(c, 413, 'invalid_request_error', 'Payload Too Large', {
    code: 'PAYLOAD_TOO_LARGE',
  })

export const validationError = (
  c: Context<Env>,
  message: string,
  param?: string,
) =>
  errorEnvelope(c, 422, 'invalid_request_error', message, {
    code: 'INVALID_REQUEST',
    param: param ?? null,
  })
