export type UserRole = 'admin' | 'agent'

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
}

/**
 * A llave de acceso as `GET /api/auth/passkey/list-user-passkeys` lists it (Better Auth's passkey
 * record, passkey-auth US5) — only the fields the Seguridad screen reads. Better Auth's client
 * revives ISO timestamps into `Date`s, so `createdAt` may arrive as either.
 */
export interface PasskeyRecord {
  id: string
  name?: string | null
  createdAt: Date | string
  /** `multiDevice` when the platform syncs it (iCloud Keychain, Google Password Manager). */
  deviceType: 'multiDevice' | 'singleDevice'
  backedUp: boolean
}
