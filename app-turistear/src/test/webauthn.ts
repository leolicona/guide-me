import { vi, type Mock } from 'vitest'

// passkey-auth D17 — app tests mock WebAuthn at the platform boundary: `window.PublicKeyCredential`
// and `navigator.credentials`. Everything above it runs for real — Better Auth's passkey client,
// SimpleWebAuthn's encoding, and the HTTP round-trips MSW answers (test/handlers/auth.ts).
// jsdom implements neither, which is also how a browser without WebAuthn looks.

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

/** What `navigator.credentials.get()` resolves to after the device verified the person. */
export const anAssertion = () => ({
  id: 'Y3JlZGVudGlhbC0x',
  rawId: bytes('credential-1'),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: {
    authenticatorData: bytes('authenticator-data'),
    clientDataJSON: bytes('{"type":"webauthn.get"}'),
    signature: bytes('signature'),
    userHandle: bytes('user-1'),
  },
  getClientExtensionResults: () => ({}),
})

/** What `navigator.credentials.create()` resolves to once a llave de acceso is made. */
export const anAttestation = () => ({
  id: 'Y3JlZGVudGlhbC0x',
  rawId: bytes('credential-1'),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: {
    attestationObject: bytes('attestation-object'),
    clientDataJSON: bytes('{"type":"webauthn.create"}'),
    getTransports: () => ['internal', 'hybrid'],
  },
  getClientExtensionResults: () => ({ credProps: { rk: true } }),
})

/** The browser's answer when the person closes the device's prompt (or it times out). */
export const promptClosed = () =>
  new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')

export interface WebAuthnStub {
  get: Mock
  create: Mock
}

/** A browser with WebAuthn; `conditional` is what `isConditionalMediationAvailable()` answers. */
export function installWebAuthn({ conditional = false }: { conditional?: boolean } = {}): WebAuthnStub {
  const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
    isConditionalMediationAvailable: () => Promise.resolve(conditional),
  })
  vi.stubGlobal('PublicKeyCredential', PublicKeyCredential)
  const stub = { get: vi.fn(), create: vi.fn() }
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: stub })
  return stub
}

/** Back to jsdom's own state: no WebAuthn at all. */
export function uninstallWebAuthn() {
  vi.unstubAllGlobals()
  delete (navigator as { credentials?: unknown }).credentials
}
