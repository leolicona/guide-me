// The one preview comment on a pull request (delivery-pipeline D7; the format is
// specs/005-delivery-pipeline/contracts/preview-comment.md).
//
//   node .github/scripts/preview-note.mjs deploy    preview.yml, job `note`
//   node .github/scripts/preview-note.mjs cleanup   preview-cleanup.yml
//
// The comment's first line is a hidden marker. It finds the comment again, and it carries what a
// later run cannot recompute: the migrations this pull request's previews have put on dev (a
// migration is pending only once, so the next run would not see it again), and the preview still
// serving after a failed run. No dependency: Node 22's fetch talks to the GitHub REST API with
// the job's own token.
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MARKER = '<!-- guide-me:preview'

// What a throwaway secret costs on a preview (delivery-pipeline D5).
const THROWAWAY_COST = {
  QR_SECRET: "tickets signed here do not validate on dev, and dev's tickets do not validate here",
  RESEND_API_KEY: 'no email leaves this preview (sign-in codes, tickets, notices)',
  // passkey-auth D5 — a new throwaway each deploy re-signs every cookie and re-keys every code.
  BETTER_AUTH_SECRET: 'every push signs everyone out of this preview and voids pending sign-in codes',
}

// devolada-transfer-verification D17 — the one secret a preview never gets as a throwaway: it
// encrypts rows in dev's database, which a throwaway key would leave unreadable to dev.
const DEVOLADA_OFF =
  "**Devolada is off on this preview**: the `dev` environment holds no `DEVOLADA_CREDENTIAL_KEY`, and a preview never gets a throwaway one. Connecting Devolada answers 500 here, and every transfer takes the manual path."

const words = (s) => (s ?? '').split(/[\s,]+/).filter(Boolean)
const code = (s) => `\`${s}\``
const short = (sha) => (sha ?? '').slice(0, 7)

/** The marker's fields, or null when the comment is not the preview comment. */
export function parseMarker(body) {
  const first = (body ?? '').split('\n', 1)[0]
  if (!first.startsWith(MARKER)) return null
  const fields = {}
  // Pairs are separated by spaces; a value (the migrations list) may hold commas.
  for (const pair of first.slice(MARKER.length).replace(/-->\s*$/, '').trim().split(/\s+/)) {
    const at = pair.indexOf('=')
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return {
    migrations: words(fields.migrations),
    served: fields.served ?? '',
    app: fields.app ?? '',
    api: fields.api ?? '',
  }
}

/** A migration on dev stays on dev: the list only grows, in name order (delivery-pipeline D19). */
export function mergeMigrations(previous, applied) {
  return [...new Set([...previous, ...applied])].sort()
}

function marker({ migrations, served }) {
  const fields = [`migrations=${migrations.join(',')}`]
  if (served?.commit) fields.push(`served=${served.commit}`, `app=${served.app}`, `api=${served.api}`)
  return `${MARKER} ${fields.join(' ')} -->`
}

const table = ({ app, api, commit }) =>
  ['| | |', '| --- | --- |', `| App | ${app} |`, `| API | ${api} |`, `| Commit | ${code(commit)} |`]

/** The comment's body for one state: ready, failed, deleted or not-deleted. */
export function render(input) {
  const { state, number, migrations, runUrl } = input
  const run = `[Run](${runUrl})`

  if (state === 'ready') {
    const served = { commit: short(input.commit), app: input.appOrigin, api: input.apiOrigin }
    const lines = [
      marker({ migrations, served }),
      '### Preview — ready',
      '',
      ...table(served),
      '',
      "Runs on dev's data: sign in with a dev account. What you sell here stays in dev.",
      '',
      `**Migrations applied to dev by this run**: ${input.applied.length ? input.applied.map(code).join(', ') : 'none'}`,
    ]
    if (migrations.length && migrations.join() !== input.applied.join()) {
      lines.push('', `**On dev from this pull request**: ${migrations.map(code).join(', ')}`)
    }
    if (input.throwaway.length) {
      lines.push(
        '',
        '**Throwaway secrets** — not in the `dev` environment, so this preview got its own value:',
        '',
        '| Secret | Cost on this preview |',
        '| --- | --- |',
        ...input.throwaway.map((name) => `| ${code(name)} | ${THROWAWAY_COST[name] ?? 'unknown'} |`),
      )
    }
    if (input.devoladaOff) lines.push('', DEVOLADA_OFF)
    lines.push('', `**Journeys** (\`e2e\` label): ${input.journeys}`, '', run)
    return lines.join('\n')
  }

  if (state === 'failed') {
    const served = input.served?.commit ? input.served : null
    const lines = [
      marker({ migrations, served }),
      '### Preview — failed',
      '',
      `The ${code(input.failedJob)} job failed on ${code(short(input.commit))}. ${run}`,
    ]
    if (input.applied.length) {
      lines.push('', `**Migrations applied to dev by this run**: ${input.applied.map(code).join(', ')}`)
    }
    if (served) lines.push('', `The preview below still serves ${code(served.commit)}:`, '', ...table(served))
    return lines.join('\n')
  }

  const workers = [`api-guideme-pr-${number}`, `app-guideme-pr-${number}`]
  const lines = [marker({ migrations })]
  if (state === 'deleted') {
    lines.push('### Preview — deleted', '', `Both Workers are gone: ${workers.map(code).join(', ')}.`)
  } else {
    lines.push(
      '### Preview — not deleted',
      '',
      `Not deleted: ${input.failed.map(code).join(', ')}. ${run}`,
    )
  }
  if (!input.merged && migrations.length) {
    lines.push(
      '',
      `This pull request was not merged, but its preview applied ${migrations.map(code).join(', ')} to dev. ` +
        'That change stays on dev; fix it forward with a later migration.',
    )
  }
  return lines.join('\n')
}

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

async function findComment(repo, number) {
  for (let page = 1; ; page += 1) {
    const batch = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)
    const hit = batch.find((c) => c.body?.startsWith(MARKER))
    if (hit || batch.length < 100) return hit ?? null
  }
}

async function main(mode) {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY
  const number = Number(env.PR_NUMBER)
  const existing = await findComment(repo, number)
  const previous = parseMarker(existing?.body) ?? { migrations: [], served: '', app: '', api: '' }
  let body

  if (mode === 'deploy') {
    const applied = words(env.APPLIED).sort()
    const migrations = mergeMigrations(previous.migrations, applied)
    body =
      env.DEPLOY === 'success'
        ? render({
            state: 'ready',
            number,
            commit: env.COMMIT,
            appOrigin: env.APP_ORIGIN,
            apiOrigin: env.API_ORIGIN,
            applied,
            migrations,
            throwaway: words(env.THROWAWAY),
            devoladaOff: env.DEVOLADA === 'off',
            journeys: { success: 'passed', failure: 'failed' }[env.JOURNEYS] ?? 'not run',
            runUrl: env.RUN_URL,
          })
        : render({
            state: 'failed',
            number,
            commit: env.COMMIT,
            failedJob: env.GATE === 'success' ? 'deploy' : 'gate',
            applied,
            migrations,
            served: previous.served ? { commit: previous.served, app: previous.app, api: previous.api } : null,
            runUrl: env.RUN_URL,
          })
  } else if (mode === 'cleanup') {
    // A pull request that never had a preview (documentation only, a fork) gets no note.
    if (!existing) return
    // "<worker> (HTTP <status>)" entries, comma-separated: they carry spaces.
    const failed = (env.FAILED ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    body = render({
      state: failed.length ? 'not-deleted' : 'deleted',
      number,
      migrations: previous.migrations,
      merged: env.MERGED === 'true',
      failed,
      runUrl: env.RUN_URL,
    })
  } else {
    throw new Error(`unknown mode "${mode}" (deploy | cleanup)`)
  }

  if (existing) {
    await gh(`/repos/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  } else {
    await gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`)
  console.log(body)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv[2]).catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
