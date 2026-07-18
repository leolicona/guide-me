export interface JwtPayload {
  sub?: string
  identity?: string
  exp?: number
}

export const decodeJwtPayload = (jwt: string): JwtPayload | null => {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(normalized)) as JwtPayload
  } catch {
    return null
  }
}

export const extractIdentity = (jwt: string): string | null => {
  const payload = decodeJwtPayload(jwt)
  return payload?.sub ?? payload?.identity ?? null
}
