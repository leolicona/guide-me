// delivery-pipeline US1 — the one preview comment: what it says in each state, and what its
// hidden marker carries from one run to the next (contracts/preview-comment.md).
import assert from 'node:assert/strict'
import test from 'node:test'

import { MARKER, mergeMigrations, parseMarker, render } from './preview-note.mjs'

const app = 'https://app-guideme-pr-7.acme.workers.dev'
const api = 'https://api-guideme-pr-7.acme.workers.dev'
const runUrl = 'https://github.com/leolicona/guide-me/actions/runs/1'

const ready = (over = {}) =>
  render({
    state: 'ready',
    number: 7,
    commit: 'abc1234def',
    appOrigin: app,
    apiOrigin: api,
    applied: [],
    migrations: [],
    throwaway: [],
    journeys: 'not run',
    runUrl,
    ...over,
  })

test('a comment without the marker is not the preview comment', () => {
  assert.equal(parseMarker('Looks good to me'), null)
  assert.equal(parseMarker(''), null)
  assert.equal(parseMarker(undefined), null)
})

test('the marker carries the migrations and the preview still serving', () => {
  const body = `${MARKER} migrations=0071_a.sql,0072_b.sql served=abc1234 app=${app} api=${api} -->\n### x`
  assert.deepEqual(parseMarker(body), {
    migrations: ['0071_a.sql', '0072_b.sql'],
    served: 'abc1234',
    app,
    api,
  })
})

test('migrations accumulate in name order, without duplicates, and never shrink', () => {
  assert.deepEqual(mergeMigrations(['0072_b.sql'], ['0071_a.sql', '0072_b.sql']), [
    '0071_a.sql',
    '0072_b.sql',
  ])
  assert.deepEqual(mergeMigrations(['0071_a.sql'], []), ['0071_a.sql'])
  // Two pull requests may each add a 0071 file; both stay, in name order (delivery-pipeline D19).
  assert.deepEqual(mergeMigrations(['0071_b.sql'], ['0071_a.sql']), ['0071_a.sql', '0071_b.sql'])
})

test('a ready preview shows both addresses, the short commit and the run', () => {
  const body = ready()
  assert.match(body, /^<!-- guide-me:preview /)
  assert.match(body, /### Preview — ready/)
  assert.ok(body.includes(`| App | ${app} |`))
  assert.ok(body.includes(`| API | ${api} |`))
  assert.ok(body.includes('| Commit | `abc1234` |'))
  assert.ok(body.includes("Runs on dev's data"))
  assert.ok(body.includes('**Migrations applied to dev by this run**: none'))
  assert.ok(body.includes('**Journeys** (`e2e` label): not run'))
  assert.ok(body.includes(`[Run](${runUrl})`))
  assert.ok(!body.includes('Throwaway'))
})

test('a ready preview names the migrations it applied and the ones it put on dev before', () => {
  const body = ready({ applied: ['0072_b.sql'], migrations: ['0071_a.sql', '0072_b.sql'] })
  assert.ok(body.includes('**Migrations applied to dev by this run**: `0072_b.sql`'))
  assert.ok(body.includes('**On dev from this pull request**: `0071_a.sql`, `0072_b.sql`'))
})

test('a throwaway BETTER_AUTH_SECRET is named with what it costs (passkey-auth D5)', () => {
  const body = ready({ throwaway: ['BETTER_AUTH_SECRET'] })
  assert.ok(body.includes('| `BETTER_AUTH_SECRET` | every push signs everyone out of this preview'))
})

test('a throwaway secret is named with what it costs', () => {
  const body = ready({ throwaway: ['QR_SECRET'] })
  assert.ok(body.includes('| `QR_SECRET` | tickets signed here do not validate on dev'))
  assert.ok(!body.includes('`RESEND_API_KEY`'))
})

test('the marker written by a ready preview is the one read back', () => {
  const body = ready({ migrations: ['0071_a.sql'] })
  assert.deepEqual(parseMarker(body), {
    migrations: ['0071_a.sql'],
    served: 'abc1234',
    app,
    api,
  })
})

test('a failed run names the job and keeps showing the preview still serving', () => {
  const body = render({
    state: 'failed',
    number: 7,
    commit: 'def5678aaa',
    failedJob: 'deploy',
    applied: [],
    migrations: [],
    served: { commit: 'abc1234', app, api },
    runUrl,
  })
  assert.match(body, /### Preview — failed/)
  assert.ok(body.includes('The `deploy` job failed on `def5678`'))
  assert.ok(body.includes('still serves `abc1234`'))
  assert.ok(body.includes(`| App | ${app} |`))
  assert.deepEqual(parseMarker(body).served, 'abc1234')
})

test('a failed first run has no addresses to show', () => {
  const body = render({
    state: 'failed',
    number: 7,
    commit: 'def5678aaa',
    failedJob: 'gate',
    applied: [],
    migrations: [],
    runUrl,
  })
  assert.ok(body.includes('The `gate` job failed on `def5678`'))
  assert.ok(!body.includes('| App |'))
  assert.equal(parseMarker(body).served, '')
})

test('a deleted preview names both Workers', () => {
  const body = render({ state: 'deleted', number: 7, migrations: [], merged: true, runUrl })
  assert.match(body, /### Preview — deleted/)
  assert.ok(body.includes('`api-guideme-pr-7`, `app-guideme-pr-7`'))
  assert.ok(!body.includes('stays on dev'))
})

test('an unmerged pull request whose preview migrated dev says the change stays there', () => {
  const body = render({ state: 'deleted', number: 7, migrations: ['0071_a.sql'], merged: false, runUrl })
  assert.ok(body.includes('was not merged, but its preview applied `0071_a.sql` to dev'))
  assert.ok(body.includes('stays on dev'))
})

test('a merged pull request whose preview migrated dev says nothing about it', () => {
  const body = render({ state: 'deleted', number: 7, migrations: ['0071_a.sql'], merged: true, runUrl })
  assert.ok(!body.includes('stays on dev'))
})

test('a deletion that failed names the Worker and its status', () => {
  const body = render({
    state: 'not-deleted',
    number: 7,
    migrations: [],
    merged: true,
    failed: ['app-guideme-pr-7 (HTTP 500)'],
    runUrl,
  })
  assert.match(body, /### Preview — not deleted/)
  assert.ok(body.includes('`app-guideme-pr-7 (HTTP 500)`'))
  assert.ok(body.includes(`[Run](${runUrl})`))
})
