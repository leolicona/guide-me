import type { BrowserContext, CDPSession, Page } from '@playwright/test'

// passkey-auth D17, R13 — end to end, a llave de acceso lives in Chrome's virtual authenticator
// (the CDP `WebAuthn` domain): a real ceremony against the deployed API, with no phone and no human.
//
// This module imports nothing at runtime, so `enroll-passkey.ts` can load it under plain Node.

/**
 * A test account's llave de acceso: what `e2e/enroll-passkey.ts` prints, and what the
 * `E2E_AGENT_PASSKEY` / `E2E_ADMIN_PASSKEY` secrets hold. Binary fields are base64, as CDP takes them.
 */
export interface PasskeySecret {
  credentialId: string
  /** The ECDSA P-256 private key, PKCS#8. A credential: it lives in a secret and nowhere else. */
  privateKey: string
  userHandle: string
  /** The environment's relying party (passkey-auth D8): `app-dev.turistearya.com` on dev. */
  rpId: string
}

const FIELDS = ['credentialId', 'privateKey', 'userHandle', 'rpId'] as const

export function parsePasskeySecret(name: string, raw: string): PasskeySecret {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${name} is not JSON — see e2e/README.md.`)
  }
  const secret = (value ?? {}) as Record<string, unknown>
  for (const field of FIELDS) {
    if (typeof secret[field] !== 'string' || !secret[field]) {
      throw new Error(`${name} has no "${field}" — see e2e/README.md.`)
    }
  }
  return secret as unknown as PasskeySecret
}

/**
 * A platform authenticator that holds discoverable credentials, verifies the user and answers
 * without a tap — what the API asks of every ceremony (FR-001, FR-002).
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

/**
 * Load an enrolled llave de acceso into the virtual authenticator, for the relying party under
 * test. A pull request's preview (delivery-pipeline D15) is another host than app-dev, but it runs
 * on dev's database, where the credential's public key lives: the same private key, offered for
 * the preview's host, verifies there — the API checks the assertion against its own APP_BASE_URL.
 */
export async function loadPasskey(
  cdp: CDPSession,
  authenticatorId: string,
  secret: PasskeySecret,
  rpId: string = secret.rpId,
): Promise<void> {
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: secret.credentialId,
      isResidentCredential: true,
      rpId,
      privateKey: secret.privateKey,
      userHandle: secret.userHandle,
      // FR-006 — the API refuses a use count at or behind the last one it recorded (the sign of a
      // cloned key). The same secret is replayed on every run, so its count starts from the clock,
      // which is always ahead of the previous run's. Seconds fit the 32-bit counter until 2106.
      signCount: Math.floor(Date.now() / 1000),
    },
  })
}
