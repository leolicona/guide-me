// Enroll one test account's llave de acceso against a deployed environment and print it as the JSON
// its E2E_*_PASSKEY secret holds (passkey-auth T042, R13). Run it once per account — the agent and
// the admin — and again only if that llave is removed from the account.
//
//   cd app-turistear
//   node --experimental-strip-types e2e/enroll-passkey.ts agente@ejemplo.mx
//
// A Chromium opens on E2E_BASE_URL (app-dev by default; HEADED=1 to watch it) and requests a sign-in
// code for the address. Type the 6 digits from that inbox here. Once signed in, it accepts the offer
// to create a llave de acceso (FR-007) into Chrome's virtual authenticator, and prints that
// credential — private key included. Paste it into the secret, and nowhere else.
//
// Plain Node runs this file (no Playwright runner), so it imports only packages, Node built-ins and
// `./passkey.ts`, which has no runtime imports.
import { chromium } from '@playwright/test'
import { createInterface } from 'node:readline/promises'
import { argv, env, exit, stdin, stdout } from 'node:process'
import { addVirtualAuthenticator, type PasskeySecret } from './passkey.ts'

const email = argv[2]?.trim().toLowerCase()
if (!email) {
  console.error('Uso: node --experimental-strip-types e2e/enroll-passkey.ts <correo>')
  exit(1)
}

const baseURL = env.E2E_BASE_URL ?? 'https://app-dev.turistearya.com'
const browser = await chromium.launch({ headless: env.HEADED !== '1' })

try {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page)

  // passkey-auth US1 — the código por correo.
  await page.goto('/login')
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Recibir código', exact: true }).click()
  const codeField = page.getByLabel('Código', { exact: true })
  await codeField.waitFor()

  const prompt = createInterface({ input: stdin, output: stdout })
  const code = (await prompt.question(`Código de 6 dígitos enviado a ${email}: `)).trim()
  prompt.close()

  await codeField.fill(code)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })

  // passkey-auth US2 — the offer follows every email-code sign-in where WebAuthn exists.
  await page.getByRole('button', { name: 'Crear llave de acceso', exact: true }).click()
  await page
    .getByRole('heading', { name: 'Llave de acceso creada', exact: true })
    .waitFor({ timeout: 30_000 })

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  const credential = credentials.find((c) => c.isResidentCredential)
  if (!credential?.rpId || !credential.userHandle) {
    throw new Error('The virtual authenticator holds no discoverable llave de acceso.')
  }

  const secret: PasskeySecret = {
    credentialId: credential.credentialId,
    privateKey: credential.privateKey,
    userHandle: credential.userHandle,
    rpId: credential.rpId,
  }
  console.log(`\nE2E secret for ${email} (rpId ${secret.rpId}):\n`)
  console.log(JSON.stringify(secret))
} finally {
  await browser.close()
}
