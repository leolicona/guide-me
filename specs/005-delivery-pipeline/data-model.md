# Data Model: delivery-pipeline

No table is added; nothing here lives in D1. These are the things the pipeline creates, names and
reads back — on Cloudflare, on GitHub and in a run's summary.

## Preview

One per open pull request into `main` from a branch of this repository that changes more than
documentation (FR-003, D16).

| Field | Value | Rule |
| --- | --- | --- |
| `number` | the pull request number | identity |
| `apiWorker` | `api-guideme-pr-<number>` | D2; ≤ 63 characters, a DNS label |
| `appWorker` | `app-guideme-pr-<number>` | D2 |
| `subdomain` | the account's `workers.dev` subdomain, read from the account | D2, R3 |
| `apiOrigin` | `https://api-guideme-pr-<number>.<subdomain>.workers.dev` | baked into the app; the API's `API_BASE_URL` |
| `appOrigin` | `https://app-guideme-pr-<number>.<subdomain>.workers.dev` | the API's `CORS_ORIGIN` and `APP_BASE_URL` |
| `commit` | the pull request's head commit served | FR-004 |
| `migrations` | every migration file this pull request's previews applied to dev, cumulative | FR-005, D7 |
| `throwaway` | the secret names that got a throwaway value on the last deploy | FR-008, D5 |
| `state` | `deploying` → `ready` \| `failed`; then `deleted` on close | below |

**State transitions**

```text
(opened / pushed / labelled e2e)          (deploy failed)
            │                                   ▲
            ▼                                   │
        deploying ──── gate red ──────────► failed ──┐
            │                                         │ (next push)
            └──── deployed + smoke green ──► ready ───┤
                                              │       ▼
                                (pull request closed) deploying …
                                              ▼
                                           deleted
```

- A newer push cancels a `deploying` run of the same pull request (FR-004).
- `deleted` is reached from any state; deleting a Worker that does not exist counts as deleted
  (FR-010).
- `migrations` never shrinks: a migration on dev stays on dev (spec Edge Cases).

## Preview comment

The one note on the pull request (FR-009). Format: [contracts/preview-comment.md](./contracts/preview-comment.md).

| Field | Source |
| --- | --- |
| marker | `<!-- guide-me:preview migrations=<file>,<file> -->`, first line; finds the comment and carries `migrations` between runs |
| state | `ready`, `failed`, `deleted` |
| addresses | `appOrigin`, `apiOrigin` |
| commit | short commit served |
| migrations | applied by this run, and the cumulative list |
| throwaway secrets | names and what each costs |
| journeys | `passed`, `failed` or not run |
| run | link to the run |

## Release

One per pushed `v*` tag (FR-014).

| Field | Value | Rule |
| --- | --- | --- |
| `tag` | `vX.Y.Z` | the approval (D10) |
| `commit` | the tagged commit | must be on `main` and have a successful *Deploy Dev* run (FR-015) |
| `gate` | `passed` \| `refused: not on main` \| `refused: no green dev deploy` | before any production step |
| `restorePoint` | bookmark + UTC time of `guideme-db-prod` before migrating | D11; never data |
| `versions.api` | live version id of `api-guideme`, or "not deployed in this run" | D12 |
| `versions.app` | live version id of `app-guideme`, or "not deployed in this run" | D12 |
| `smoke` | per hostname: answered \| did not answer in 5 minutes | D13 |

Order is fixed: gate → verify → restore point → migrations → API → app → summary → smoke (FR-016).

## Restore point

Where `guideme-db-prod` stood immediately before a release migrated it (D11).

| Field | Value |
| --- | --- |
| `bookmark` | D1 Time Travel bookmark, from `wrangler d1 time-travel info --json` |
| `time` | UTC time taken, RFC 3339 |
| `usableUntil` | 30 days after `time` |

Using it is a deliberate act (runbook §6). A restore itself prints a bookmark to undo it.

## Rollback

One manual run (FR-021).

| Field | Value |
| --- | --- |
| `worker` | `api` → `api-guideme`, `app` → `app-guideme` |
| `versionId` | from a release summary |
| `verdict` | `now serving <versionId>` \| `did not take: live is <id>` |

Never touches the database, the secrets or the other Worker (FR-022).

## Environments (GitHub)

| Environment | Used by | Admits | Holds |
| --- | --- | --- | --- |
| `dev` | preview, cleanup, dev deploy, journeys | every branch (pull-request branches deploy previews) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `E2E_*`; optionally `QR_SECRET`, `RESEND_API_KEY` for previews (D5) |
| `production` | release, rollback | tags `v*` and the branch `main` (D10) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

Details and checks: [contracts/environment.md](./contracts/environment.md).
