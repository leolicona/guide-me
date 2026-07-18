import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ApiError } from '../types/errors'

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as 400 | 401 | 403 | 404 | 409 | 500,
    )
  }

  if (err instanceof HTTPException) {
    return err.getResponse()
  }

  console.error('Unhandled error:', err)
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500,
  )
}
