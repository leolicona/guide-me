# Contract: what lives outside the repository

The pipeline depends on settings that no file in this repository can set. The developer sets each
one, once, during the cutover (quickstart §0). The agent never handles a secret value.

| # | Setting | Value | Why | How to check |
| --- | --- | --- | --- | --- |
| E1 | `dev` environment → deployment branches | **No restriction** | previews deploy from pull-request branches, dev from `main` (D2, D9) | Settings → Environments → dev; the first preview's `deploy` job starts instead of "Branch is not allowed to deploy to dev" |
| E2 | `dev` environment → secrets `QR_SECRET`, `RESEND_API_KEY` | dev's values (the ones on `api-guideme-dev`) | a preview signs tickets and sends email like dev (D5). Optional: without them a preview gets throwaway values and says so | the preview comment has no "throwaway" section |
| E3 | `production` environment → deployment branches and tags | tags `v*` and the branch `main`, nothing else | the tag is the approval; rollback dispatches from `main` (D10, D14) | Settings → Environments → production → "Deployment branches and tags" |
| E4 | `production` environment → required reviewers | none | the creator chose the tag alone (Clarifications) | same page |
| E5 | Branch `main` → protection | require a pull request and the status check **`verify`** | the gate stays the merge gate (FR-002) | Settings → Branches (or Rulesets) |
| E6 | Pull requests still targeting `develop` | retargeted to `main` | `develop` is deleted next | the pull request list filtered by `base:develop` is empty |
| E7 | Branch `develop` | deleted, after E6 | one branch (D1) | `git ls-remote origin develop` prints nothing |
| E8 | Cloudflare token (`CLOUDFLARE_API_TOKEN`, in `dev` and `production`) | can edit Workers scripts, read the account's Workers subdomain, edit D1 | previews create and delete Workers; releases use Time Travel and roll back (R3, R8, R9) | the first preview deploys and the first release prints a bookmark |
| E9 | The account's `workers.dev` subdomain | enabled | previews live there (D2) | Workers & Pages → Overview → "Your subdomain" |

Unchanged and still required: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in both
environments; `E2E_AGENT_EMAIL`, `E2E_AGENT_PASSWORD`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` in
`dev`; the secrets already on `api-guideme-dev` and `api-guideme` (D17, superseded below).

*2026-10-15, `specs/004-passkey-auth` T042*: the journeys sign in with a llave de acceso, so the
`dev` environment holds `E2E_AGENT_PASSKEY` and `E2E_ADMIN_PASSKEY` instead of the four
`E2E_*_EMAIL` / `E2E_*_PASSWORD` secrets (`app-turistear/e2e/README.md`). A preview also takes
`BETTER_AUTH_SECRET` from the `dev` environment, like `QR_SECRET` and `RESEND_API_KEY` (D5).

*2026-10-15, constitution v1.4.0 (supersedes D17)*: secrets are managed in the GitHub environments.
`dev` and `production` each hold `BETTER_AUTH_SECRET` (required: a deploy without it stops before
migrating), and may hold `QR_SECRET` and `RESEND_API_KEY`; every dev deploy and prod release plants
the ones present on its API Worker with the version it ships (`--secrets-file`, additive). Copy
`QR_SECRET` and `RESEND_API_KEY` from the Worker's exact current value, or leave them out: a wrong
`QR_SECRET` invalidates every live ticket.
