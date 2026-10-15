// passkey-auth D17, R13 — a software FIDO2 authenticator for the API tests.
//
// WebCrypto ECDSA P-256 (ES256), attestation `none`. It builds exactly the JSON a browser hands to
// `@simplewebauthn/browser`, so the passkey plugin verifies a real ceremony in workerd: a real
// challenge, rpIdHash, origin, signature and use counter. Nothing in src/ knows it exists.

type Json = Record<string, unknown>

const enc = new TextEncoder()

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const fromB64url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data))

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

// ─── Minimal CBOR (RFC 8949): what attestation objects and COSE keys need ──────────────────────
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>

const cborHead = (major: number, n: number): Uint8Array => {
  if (n < 24) return Uint8Array.of((major << 5) | n)
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n)
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff)
  return concat(Uint8Array.of((major << 5) | 26), u32(n))
}

const cbor = (v: Cbor): Uint8Array => {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v)
  if (typeof v === 'string') {
    const b = enc.encode(v)
    return concat(cborHead(3, b.length), b)
  }
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v)
  const entries = [...v.entries()]
  return concat(cborHead(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)]))
}

// WebCrypto signs ECDSA as raw r||s; WebAuthn's ES256 wants the ASN.1 DER sequence.
const derSignature = (raw: Uint8Array): Uint8Array => {
  const int = (x: Uint8Array) => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    let v = x.slice(i)
    if (v[0]! & 0x80) v = concat(Uint8Array.of(0), v)
    return concat(Uint8Array.of(0x02, v.length), v)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

// Authenticator data flags (WebAuthn §6.1).
const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

export interface SoftCredential {
  id: string // base64url credential id
  rpId: string
  userHandle: string // base64url, as the registration options sent it
  privateKey: CryptoKey
  counter: number
}

export interface CeremonyOptions {
  origin: string
  userVerified?: boolean
  // The use count the authenticator reports. Registration defaults to 0; an assertion defaults to
  // the credential's last count + 1, as a real authenticator increments it.
  counter?: number
  // A synced passkey (multiDevice, backed up) rather than a device-bound one.
  synced?: boolean
}

interface RegistrationOptionsJSON {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
}

interface AuthenticationOptionsJSON {
  challenge: string
  rpId?: string
}

const clientData = (type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) =>
  enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

export const createCredential = async (
  options: RegistrationOptionsJSON,
  { origin, userVerified = true, counter = 0, synced = true }: CeremonyOptions,
): Promise<{ response: Json; credential: SoftCredential }> => {
  const rpId = options.rp.id ?? new URL(origin).hostname
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const credId = crypto.getRandomValues(new Uint8Array(32))

  const coseKey = cbor(
    new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, fromB64url(jwk.x!)],
      [-3, fromB64url(jwk.y!)],
    ]),
  )
  const flags = UP | AT | (userVerified ? UV : 0) | (synced ? BE | BS : 0)
  const authData = concat(
    await sha256(enc.encode(rpId)),
    Uint8Array.of(flags),
    u32(counter),
    new Uint8Array(16), // aaguid: all zeros, as `none` attestation from a platform reports
    Uint8Array.of(credId.length >> 8, credId.length & 0xff),
    credId,
    coseKey,
  )
  const attestationObject = cbor(
    new Map<string, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  )
  const id = b64url(credId)

  return {
    response: {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
    },
    credential: { id, rpId, userHandle: options.user.id, privateKey: keyPair.privateKey, counter },
  }
}

export const getAssertion = async (
  options: AuthenticationOptionsJSON,
  credential: SoftCredential,
  { origin, userVerified = true, counter, synced = true }: CeremonyOptions,
): Promise<Json> => {
  const signCount = counter ?? credential.counter + 1
  const rpId = options.rpId ?? credential.rpId
  const authData = concat(
    await sha256(enc.encode(rpId)),
    Uint8Array.of(UP | (userVerified ? UV : 0) | (synced ? BE | BS : 0)),
    u32(signCount),
  )
  const cd = clientData('webauthn.get', options.challenge, origin)
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      credential.privateKey,
      concat(authData, await sha256(cd)),
    ),
  )
  credential.counter = signCount

  return {
    id: credential.id,
    rawId: credential.id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(cd),
      authenticatorData: b64url(authData),
      signature: b64url(derSignature(raw)),
      userHandle: credential.userHandle,
    },
  }
}
