# Contract: the preview comment

One comment per pull request (FR-009, D7), written by `.github/scripts/preview-note.mjs`. English,
because it is a repository artifact, not product copy.

## Finding it

The first line is a hidden marker:

```text
<!-- guide-me:preview migrations=0071_add_x.sql,0072_add_y.sql served=abc1234 app=https://… api=https://… -->
```

- The script lists the pull request's comments and takes the first one whose body starts with
  `<!-- guide-me:preview`. If there is one, it is edited in place; if not, one is created.
- Fields are `key=value` pairs separated by spaces; no value holds a space.
- `migrations=` holds every migration file this pull request's previews have applied to dev,
  comma-separated, in name order, without duplicates. Empty means none. Each run adds what it
  applied; nothing is ever removed.
- `served=`, `app=` and `api=` name the preview that is live — written by a ready run, kept by a
  failed one (so it can say what still serves), dropped on deletion.

## Bodies

**Ready**

```markdown
<!-- guide-me:preview migrations=… -->
### Preview — ready

| | |
| --- | --- |
| App | https://app-guideme-pr-<n>.<subdomain>.workers.dev |
| API | https://api-guideme-pr-<n>.<subdomain>.workers.dev |
| Commit | `abc1234` |

Runs on dev's data: sign in with a dev account. What you sell here stays in dev.

**Migrations applied to dev by this run**: `0071_add_x.sql` *(or: none)*

**On dev from this pull request**: `0071_add_x.sql`, `0072_add_y.sql` *(only when it differs from the line above)*

**Journeys** (`e2e` label): passed · failed · not run

[Run](<run url>)
```

**Failed** — the same table, the title `### Preview — failed`, and one line naming the job that
failed (`gate`, `deploy` or `journeys`) with the run link. The addresses are kept when a previous
preview still serves an older commit, and the line says which commit.

**Deleted** (on close)

```markdown
<!-- guide-me:preview migrations=… -->
### Preview — deleted

Both Workers are gone: `api-guideme-pr-<n>`, `app-guideme-pr-<n>`.
```

When the pull request was closed **without merging** and `migrations=` is not empty, one more line:

```markdown
This pull request was not merged, but its preview applied `0071_add_x.sql` to dev. That change
stays on dev; fix it forward with a later migration.
```

When a deletion fails, the title is `### Preview — not deleted`, and the line names the Worker
and the HTTP status, with the run link.

## Throwaway secrets

When a secret is missing from the `dev` environment (D5), a section lists each one with its cost:

| Secret | Cost on this preview |
| --- | --- |
| `QR_SECRET` | tickets signed here do not validate on dev, and dev's tickets do not validate here |
| `RESEND_API_KEY` | no email leaves this preview (sign-in links, tickets, notices) |

## Silence

- No comment at all for a pull request from a fork, or one that changes only documentation (D16).
- On close, no comment is created when none exists.
