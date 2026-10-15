// passkey-auth US5 — manage my llaves de acceso and sessions (specs/004-passkey-auth/spec.md,
// Story 5, scenarios 1–5; FR-004, FR-040, FR-041). Better Auth's standard passkey routes do list,
// rename and delete, each scoped to the signed-in user (constitution III, checked with
// `seedTwoOrgs`); notices go out after the change, in the background (D12, constitution VIII).
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedTwoOrgs } from '../helpers/tenancy'
import { sessionCookie, sessionCookieFor } from '../helpers/session'
import {
  API,
  AUTH,
  clearAuthDb,
  post,
  registerPasskey,
  signInWithPasskey,
  stubResend,
  type SentEmail,
} from '../helpers/auth-flows'

let sent: SentEmail[]

const list = (cookie: string) =>
  SELF.fetch(`${AUTH}/passkey/list-user-passkeys`, { headers: { Cookie: cookie } })

const passkeyRows = () =>
  env.DB.prepare('SELECT id, user_id, name FROM passkeys ORDER BY name').all<{
    id: string
    user_id: string
    name: string
  }>()

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  sent = stubResend()
})
afterEach(() => vi.restoreAllMocks())

describe('passkey-auth US5 — list, rename and remove my llaves de acceso', () => {
  it('scenario 1 — the list shows each one with its name and creation date, only mine', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await registerPasskey(sessionCookie(orgA.adminEmail), { name: 'Teléfono' })
    await registerPasskey(sessionCookie(orgA.adminEmail), { name: 'Llave USB' })
    await registerPasskey(sessionCookie(orgB.adminEmail), { name: 'De la otra empresa' })

    const res = await list(sessionCookie(orgA.adminEmail))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any[]
    expect(body.map((p) => p.name).sort()).toEqual(['Llave USB', 'Teléfono'])
    for (const p of body) {
      // The shape MSW copies.
      expect(p).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        createdAt: expect.any(String),
        deviceType: 'multiDevice',
        backedUp: true,
      })
      expect(p).not.toHaveProperty('token')
    }
  })

  it('without a session the list is refused', async () => {
    expect((await list('')).status).toBe(401)
  })

  it('scenario 2 — renaming my own works; another organization’s id is refused and unchanged (constitution III)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await registerPasskey(sessionCookie(orgA.adminEmail), { name: 'Mía' })
    await registerPasskey(sessionCookie(orgB.adminEmail), { name: 'Ajena' })
    const rows = (await passkeyRows()).results
    const mine = rows.find((r) => r.name === 'Mía')!
    const theirs = rows.find((r) => r.name === 'Ajena')!

    const foreign = await post(
      '/passkey/update-passkey',
      { id: theirs.id, name: 'Robada' },
      { Cookie: sessionCookie(orgA.adminEmail) },
    )
    expect(foreign.status).toBe(401)

    const own = await post(
      '/passkey/update-passkey',
      { id: mine.id, name: 'Teléfono de trabajo' },
      { Cookie: sessionCookie(orgA.adminEmail) },
    )
    expect(own.status).toBe(200)
    expect(((await own.json()) as any).passkey).toMatchObject({ id: mine.id, name: 'Teléfono de trabajo' })

    const after = (await passkeyRows()).results
    expect(after.find((r) => r.id === theirs.id)?.name).toBe('Ajena')
    expect(after.find((r) => r.id === mine.id)?.name).toBe('Teléfono de trabajo')
  })

  it('scenario 3 — removing one: it no longer signs in, another still does; the last can go too', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const cookie = sessionCookie(orgA.adminEmail)
    const first = await registerPasskey(cookie, { name: 'Uno' })
    const second = await registerPasskey(cookie, { name: 'Dos' })
    await registerPasskey(sessionCookie(orgB.adminEmail), { name: 'Ajena' })
    const rows = (await passkeyRows()).results
    const uno = rows.find((r) => r.name === 'Uno')!
    const ajena = rows.find((r) => r.name === 'Ajena')!

    const foreign = await post('/passkey/delete-passkey', { id: ajena.id }, { Cookie: cookie })
    expect(foreign.status).toBe(401)
    expect((await passkeyRows()).results.some((r) => r.id === ajena.id)).toBe(true)

    const res = await post('/passkey/delete-passkey', { id: uno.id }, { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })

    expect((await signInWithPasskey(first.credential!)).res.status).toBe(401)
    expect((await signInWithPasskey(second.credential!)).res.status).toBe(200)

    const dos = (await passkeyRows()).results.find((r) => r.name === 'Dos')!
    expect((await post('/passkey/delete-passkey', { id: dos.id }, { Cookie: cookie })).status).toBe(200)
    expect((await list(cookie)).status).toBe(200)
    expect(await (await list(cookie)).json()).toEqual([])
  })
})

describe('passkey-auth FR-041 — a notice for each llave de acceso added or removed', () => {
  it('scenario 5 — adding and removing each send one, to the account’s address', async () => {
    const { orgA } = await seedTwoOrgs()
    const cookie = sessionCookie(orgA.adminEmail)
    await registerPasskey(cookie, { name: 'Teléfono' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ to: orgA.adminEmail })
    expect(sent[0]!.subject).toMatch(/Se agregó una llave de acceso/)

    const [row] = (await passkeyRows()).results
    await post('/passkey/delete-passkey', { id: row!.id }, { Cookie: cookie })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ to: orgA.adminEmail })
    expect(sent[1]!.subject).toMatch(/Se eliminó una llave de acceso/)
  })

  it('a refused change sends nothing', async () => {
    const { orgA } = await seedTwoOrgs()
    await post('/passkey/delete-passkey', { id: 'does-not-exist' }, { Cookie: sessionCookie(orgA.adminEmail) })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(0)
  })

  it('a Resend failure never undoes the change (constitution VIII)', async () => {
    vi.restoreAllMocks()
    stubResend({ fail: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { orgA } = await seedTwoOrgs()
    const cookie = sessionCookie(orgA.adminEmail)

    const added = await registerPasskey(cookie, { name: 'Teléfono' })
    expect(added.res.status).toBe(200)
    const [row] = (await passkeyRows()).results
    expect(row?.name).toBe('Teléfono')

    expect((await post('/passkey/delete-passkey', { id: row!.id }, { Cookie: cookie })).status).toBe(200)
    expect((await passkeyRows()).results).toHaveLength(0)
  })
})

describe('passkey-auth US5 scenario 4 — sign out on every device', () => {
  it('revoke-sessions ends a session on another device at its next request', async () => {
    const { orgA } = await seedTwoOrgs()
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, 'other-browser', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), orgA.adminUserId, now + 6 * 86400, now, now)
      .run()
    const otherBrowser = sessionCookieFor('other-browser')
    expect((await SELF.fetch(`${API}/me`, { headers: { Cookie: otherBrowser } })).status).toBe(200)

    const res = await post('/revoke-sessions', {}, { Cookie: sessionCookie(orgA.adminEmail) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    expect((await SELF.fetch(`${API}/me`, { headers: { Cookie: otherBrowser } })).status).toBe(401)
  })
})
