import { request } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const P = resolve(here, '.auth/agent.json')
const PATCH = resolve(here, '.auth/patched.json')
const s = JSON.parse(readFileSync(P, 'utf8'))
const future = Math.floor(Date.now() / 1000) + 86400
for (const c of s.cookies) if (c.name === 'gm_access') c.expires = future // let Playwright SEND the JWT-expired cookie
writeFileSync(PATCH, JSON.stringify(s))
const ctx = await request.newContext({ baseURL: 'https://api-dev.turistearya.com', storageState: PATCH })
const me = await ctx.get('/api/me')
console.log('/api/me after patch:', me.status())
if (me.ok()) {
  const j = await me.json(); console.log('  user:', j.user?.email, j.user?.role)
  await ctx.storageState({ path: P }) // save the refreshed cookies back
  console.log('✓ session refreshed & saved (no re-login needed)')
}
await ctx.dispose()
