# ⚠️ Not the canonical spec location — see `docs/`

Every product and feature spec lives in **`docs/`**, indexed by `docs/SPEC.md`. The process is
`docs/PROCESS.md`. This folder predates that rule and holds **Spanish-language drafts of the auth
specs**, four of which were later rewritten in English under `docs/auth/`.

**Do not add files here.** A new spec goes to `docs/<domain>/<feature>.spec.md`.

## What is here, and why it has not simply been deleted

| File | Status |
|---|---|
| `auth/admin-registration.spec.md` | Duplicate of `docs/auth/admin-registration.spec.md` (same 115 lines, same 11 sections — translation only) |
| `auth/password-recovery.spec.md` | Duplicate of `docs/auth/password-recovery.spec.md` (same 125 lines, same 12 sections) |
| `auth/admin-login-session.spec.md` | Near-duplicate — the English version at `docs/auth/` is **longer** (182 vs 163 lines), so it is the newer one |
| `auth/agent-invitation.spec.md` | Near-duplicate — this Spanish version is **16 lines longer** than `docs/auth/agent-invitation.spec.md`; the difference has not been reviewed |
| `auth/agent-magic-link.spec.md` | **Only copy.** Passwordless agent login by email *or* WhatsApp, 7 scenarios. No counterpart in `docs/auth/`, and no story in `SPEC.md` — it may describe a path that was never built |

Reconciling the last two is tracked in `docs/TECH_DEBT.md`. Until then these files stay, because
deleting them would drop the only copy of content nothing else records.
