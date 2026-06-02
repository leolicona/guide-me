import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../types/errors'
import type { AppVariables, UserRole } from '../types/context'

type RoleEnv = { Bindings: CloudflareBindings; Variables: AppVariables }

export const requireRole =
  (...allowedRoles: UserRole[]): MiddlewareHandler<RoleEnv> =>
  async (c, next) => {
    const user = c.get('user')
    if (!user || !allowedRoles.includes(user.role)) {
      throw new ApiError('FORBIDDEN', 403, 'Insufficient permissions')
    }
    return next()
  }
