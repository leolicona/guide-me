import { expect, type Page } from '@playwright/test'

// Read a required env var (credentials / target ids). Throws a clear message rather than running
// with an empty value — the test NEVER hardcodes a password; the runner supplies them at runtime.
export function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name} — see e2e/README.md.`)
  return v
}

// Log in through the real form. Playwright types the runner-provided password at runtime; it is
// never stored in this repo. Waits until the SPA leaves /login (session cookie set).
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').first().fill(email)
  // The password field pairs its label with a visibility toggle, so scope to the input itself.
  await page.getByLabel('Contraseña').first().fill(password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 })
}
