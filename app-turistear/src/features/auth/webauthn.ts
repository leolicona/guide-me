// passkey-auth D14, spec § Edge Cases — a browser without WebAuthn (an old Android WebView, the
// in-app browser WhatsApp or a mail app opens) never shows the llave de acceso: the email code
// always works there.
export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'

/**
 * Conditional UI (the device offers its llaves de acceso from the email field's autofill) only
 * where the browser says it can. Anything else — a missing method, a rejection — is a no.
 */
export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false
  try {
    return (await window.PublicKeyCredential.isConditionalMediationAvailable?.()) === true
  } catch {
    return false
  }
}

const PLATFORM_NAMES: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

/**
 * The name a new llave de acceso gets (FR-004): the kind of device it was created on, which is
 * what a person recognises when they later remove a lost phone. They can rename it on Seguridad.
 */
export function defaultPasskeyName(userAgent: string = navigator.userAgent): string {
  return PLATFORM_NAMES.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Llave de acceso'
}
