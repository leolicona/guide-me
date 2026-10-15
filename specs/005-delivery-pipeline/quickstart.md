# Runbook: delivery-pipeline

How to finish the cutover, how a pull request gets its preview, how to release, how to undo. Each
section ends with what proves it worked; the proof of the first time is linked from this feature's
pull request.

Settings referred to as E1–E9 are in [contracts/environment.md](./contracts/environment.md); the
order of every run is in [contracts/pipeline.md](./contracts/pipeline.md).

## §0 — The cutover (once)

`develop` retires with this feature's implementation pull request (D1). The feature ships in two
pull requests: its documentation, squash-merged into `develop` as usual, then its implementation
into `main`.

**Before merging the implementation pull request**

0. Merge the documentation pull request into `develop`. Then bring `develop` into the
   implementation branch and point the implementation pull request at `main`: only then do its CI
   and its preview run, because both listen to pull requests into `main`.
1. Set **E1**: the `dev` environment admits every branch. Without it the implementation pull
   request's own preview cannot deploy.
2. Optionally set **E2**: `QR_SECRET` and `RESEND_API_KEY` in the `dev` environment, with the
   values `api-guideme-dev` already holds. If you no longer have dev's `QR_SECRET`, leave E2 unset:
   previews then use throwaway values and say so. (Minting a new one would mean changing dev's
   Worker too, and every ticket already sold on dev would stop validating.)
3. Read the implementation pull request's preview comment: open the app address on a phone, sign in with a dev
   account, open a sale. This is User Story 1's first proof.

**Merging**

4. Merge the implementation pull request into `main` with **a merge commit** (not squash): it
   carries `develop`'s last commits (#163 and this feature's documentation) with it, and
   `develop`'s history stays in `main`.
5. Watch *Deploy Dev* on `main`: gate, migrations, API, app, smoke — green. Nothing touched
   production: the old "deploy on push to `main`" workflow is gone.

**Right after**

6. Set **E3** and **E4**: `production` admits tags `v*` and `main` only, with no required reviewer.
7. Set **E5**: `main` requires a pull request and the `verify` check.
8. **E6**: retarget every open pull request from `develop` to `main` (today: #161).
9. **E7**: delete `develop`.

**Proof**: `git ls-remote origin develop` prints nothing; the merge commit has a green *Deploy
Dev* run.

## §1 — A pull request's preview

Open a pull request into `main` from a branch of this repository.

- Within about 10 minutes, one comment shows the app and API addresses and the commit
  ([preview-comment.md](./contracts/preview-comment.md)). Each push updates the same comment.
- The preview runs on **dev's data**. If the pull request adds a migration, the preview applied it
  to dev, and the comment names it. Never rename a migration once it has reached dev (D19).
- Add the `e2e` label to run the journeys against this preview; the result joins the comment. It
  never blocks the merge.
- Closing the pull request deletes both Workers; the comment says so.

**Proof**: the comment's addresses answer, a dev account can sign in, and after the close
`api-guideme-pr-<n>` and `app-guideme-pr-<n>` are absent from the account's Workers.

## §2 — Dev

Every merge into `main` runs *Deploy Dev*: the same gate, then dev's migrations, the API, the app,
and a smoke of `api-dev` and `app-dev`. Two merges queue. Nothing to do by hand.

## §3 — A release

1. Pick a commit on `main` whose *Deploy Dev* run is green — usually the tip.
2. Tag and push it:

   ```sh
   git fetch origin main
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

   The first release after the cutover is `v1.0.0` unless you choose otherwise; it redeploys what
   production already runs plus nothing new, which makes it a safe first proof.
3. Watch *Deploy Prod*: `gate` → `verify` → `deploy` (restore point, migrations, API, app,
   *What landed*, smoke).

**Read the release**: the run summary, section *What landed*, holds the tag, the commit, the
restore point (bookmark and time) and the version id of each Worker. Keep it: the version ids are
what *Rollback Prod* takes, and the bookmark is how the data comes back (§6).

**If the gate refuses**: the message says why — not on `main`, or no green *Deploy Dev* run. If dev
was still deploying, wait for it to finish green, then *Re-run all jobs* on the refused release; it
is the same commit and the same tag.

## §4 — Proving the refusal (once, with the first release)

SC-004 asks for one refused tag on record:

```sh
git tag v0.0.1-refused <a commit of this feature's branch>   # on main through the merge, but it never ran Deploy Dev
git push origin v0.0.1-refused
```

*Deploy Prod* stops at `gate` with "No green Deploy Dev run". Then remove the tag:

```sh
git push origin :refs/tags/v0.0.1-refused && git tag -d v0.0.1-refused
```

## §5 — Undo one Worker

1. Actions → *Rollback Prod* → *Run workflow* on `main`.
2. `worker`: `api` or `app`. `version_id`: the previous release's version for that Worker (its
   *What landed*), or one from the Worker's deployments in the Cloudflare dashboard.
3. Green means that version is live, read back from Cloudflare. Red means nothing moved, and the
   message says what is live.

The database is not touched. Migrations are backward-compatible with the code already deployed, so
an older Worker keeps working on the newer schema.

## §6 — Restore production data (rare, deliberate)

Only when a release damaged data, and within 30 days of its restore point. Everything written to
production after that point is lost by the restore — sales included. Decide that first.

```sh
cd api-turistear
pnpm exec wrangler d1 time-travel restore guideme-db-prod --env production --bookmark <bookmark from What landed>
```

The command prints a bookmark for the state just before the restore; keep it, it undoes the
restore the same way.

## §7 — Journeys

- On a pull request: the `e2e` label (§1).
- Nightly at 08:00 UTC against dev, and by hand from Actions → *E2E* (optional `base_url`).
- Runs never overlap: they share dev's data.
