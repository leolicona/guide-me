#!/usr/bin/env node
// Share ONE local D1 replica across every worktree of this clone, then apply migrations to it.
//
//   pnpm db:migrate:local
//
// ── Why a symlink, and not `--persist-to` ─────────────────────────────────────────────────────
// The obvious fix is to point both tools at a shared directory: `--persist-to` for the wrangler
// CLI, `persistState: { path }` for @cloudflare/vite-plugin. It was tried, and it does not work —
// the two do not agree on the layout underneath. The dev server dies before serving a request:
//
//     Fatal uncaught kj::Exception: SENTRY_DO SQLite failed;
//     table _cf_ALARM has 3 columns but 2 values were supplied
//
// Deleting the Durable Object state does not help; the plugin recreates it and fails the same way.
// So instead of making two tools negotiate a path, this makes the FILESYSTEM do it: both keep
// writing to their own default `api-turistear/.wrangler`, and that directory is a link to one
// shared location. Nothing has to agree about anything.
//
// The link target is the main clone (found by walking up to a `.git` DIRECTORY — in a linked
// worktree `.git` is a file, so this lands on the main clone from anywhere).

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

function mainCloneRoot() {
  let dir = pkgRoot
  for (let i = 0; i < 12; i++) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const root = mainCloneRoot()
const localWrangler = join(pkgRoot, '.wrangler')

if (!root) {
  console.log('→ no main clone found; using this package’s own .wrangler')
} else {
  const shared = join(root, '.wrangler-shared')
  mkdirSync(shared, { recursive: true })

  const link = existsSync(localWrangler) || lstatSync(localWrangler, { throwIfNoEntry: false })
  if (link && lstatSync(localWrangler).isSymbolicLink()) {
    const current = readlinkSync(localWrangler)
    if (resolve(pkgRoot, current) !== shared) {
      console.error(`✗ ${localWrangler} links somewhere unexpected (${current}). Remove it and re-run.`)
      process.exit(1)
    }
    console.log(`→ already sharing ${shared}`)
  } else if (link) {
    // A real directory from before this script existed. Keep it — it may hold the only copy of the
    // data — but move it aside rather than deleting someone's local state without asking.
    const parked = `${localWrangler}.worktree-local`
    renameSync(localWrangler, parked)
    symlinkSync(shared, localWrangler)
    console.log(`→ parked this worktree’s own state at ${parked}`)
    console.log(`→ now sharing ${shared}`)
  } else {
    symlinkSync(shared, localWrangler)
    console.log(`→ sharing ${shared}`)
  }
}

execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'guideme-db', '--local'], {
  stdio: 'inherit',
  cwd: pkgRoot,
})
