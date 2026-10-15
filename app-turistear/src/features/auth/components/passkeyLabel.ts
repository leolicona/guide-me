import type { PasskeyRecord } from '../types'

/** A llave de acceso's display name — Better Auth stores none when the client sent none. */
export const passkeyLabel = (passkey: Pick<PasskeyRecord, 'name'>) =>
  passkey.name?.trim() || 'Llave de acceso'

/**
 * Synced to the platform account (iCloud Keychain, Google Password Manager) or kept on one
 * authenticator — a security key, most often. Told by Better Auth's `deviceType` / `backedUp`.
 */
export const isSyncedPasskey = (passkey: Pick<PasskeyRecord, 'deviceType' | 'backedUp'>) =>
  passkey.deviceType === 'multiDevice' || passkey.backedUp
