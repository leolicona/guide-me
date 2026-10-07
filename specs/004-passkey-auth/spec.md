# Feature Specification: Passkey Sign-In with Email Code Backup

**Feature Branch**: `claude/webauth-passkeys-fido-auth-ylusuh`

**Created**: 2026-10-06 · **Amended**: 2026-10-07

**Status**: Draft

**Input**: User description: "Dejamos agnostic auth. En adelante, la autenticación debe hacerse con webauth, passkyes, FIDO y correo mas OTP como método de recuperación o respaldo."

## Clarifications

### Session 2026-10-06

- **Is creating a llave de acceso optional or mandatory?** Answer: mandatory for every role. *Superseded on 2026-10-07* by "Follow Better Auth's standards" below.
- **Do shift operators move to llaves de acceso?** Answer: out of scope. *Superseded the same day*: affiliates and their shift operators were retired from the code (`specs/001-retire-affiliates`). No PIN depends on Agnostic Auth any more, so this feature retires Agnostic Auth entirely (FR-062).
- **Which roles does this feature cover?** Answer: only the roles that exist, `admin` and `agent`. `specs/003-delete-legacy-affiliates` deleted the last user row stored with any other role and removed the guard that refused it (its D5 and D8). This feature adds no such guard.
- **What implements the authentication?** Answer: **Better Auth** (developer's decision). It is an authentication library that runs inside the API Worker, not a service we call.

### Session 2026-10-07

- **How closely do we follow Better Auth?** Answer: **we adopt its standards** (developer's decision).
  - We use its routes, its client, its error format and codes, and its defaults wherever the product allows.
  - We configure it; we do not wrap it or rebuild what it already does.
  - Where the constitution's route and error rules differ, the constitution is amended for `/api/auth/*`.
- **Is creating a llave de acceso mandatory?** Answer: **no; Better Auth's standard.**
  - After an email-code sign-in on a capable device, the app offers to create one, and the user may decline.
  - The email code always signs in.
  - Any llave de acceso can be removed.
- **Can an admin restore an agent's access?** Answer: **removed from this feature.**
  - Better Auth's admin tools act across every organization, which constitution III forbids.
  - Suspending an agent (US-A08) already blocks them at their next request.
  - An agent who lost a phone removes its llave from another device.
  - A tenant-scoped restore can be specified later as its own feature.
- **How long does a session last without use?** Answer: **7 days, Better Auth's default.** Every day of use renews it.
- **Do we keep the BFF?** Answer: **yes.** The API stays the only holder of the session, and no response body carries the session token. Better Auth's standard answers echo the token, so the API strips it and does not expose Better Auth's session-reading routes. The app reads its user from `/api/me` (constitution IV, v1.2.1).

### Amended by the plan

- **FR-061 and SC-006: when the passwords go.** Password material is removed by the deploy that follows cutover, not by cutover itself. The cutover's migration runs before its code, and the code it replaces still reads the columns (`passkey-auth D15`). This is the same path `specs/001-retire-affiliates` → `specs/002-drop-affiliate-tables` took.

## Context — what is broken today

Staff (admins and agents) sign in with an email and a password. Everything that proves who they are goes through Agnostic Auth, a service we do not own (constitution VIII).

- **Six of its operations sit on our critical path**: password hashing, password verification, magic-link issue and verification, session renewal and session revocation.
- **Eight entry points** call it directly: register, verify (GET and POST), login, logout, invite completion, password reset and session renewal.
- **Every authenticated request** needs it once its 10-minute access token has expired.
- **When it is unreachable**, nobody can sign in, sign up, accept an invitation or reset a password, and no session renews. A sale cannot start without a session, so an outage stops sales.
- **Dev and prod share one auth realm.** `api-turistear/wrangler.jsonc` points both environments at the production service with the same app id ("Shared auth realm"). This contradicts constitution VIII ("no two environments share a signing secret").
- **The secret is a password**: typed on a phone, outdoors, one-handed; phishable and reusable. Forgetting it opens an 8-scenario recovery flow by email (`test/auth/password-recovery.test.ts`). In practice the email already is the root of trust, and the password only adds friction on top of it.
- **Local development cannot sign in** without the external worker. CLAUDE.md warns that a fresh worktree gets "200 and no session".

This feature retires passwords and Agnostic Auth.
- **Llave de acceso**: staff sign in with a **passkey**, the WebAuthn/FIDO2 credential their phone or security key already protects with a fingerprint, face or device PIN.
- **Código por correo**: an **email code**, a one-time code sent to the user's address, is the backup and recovery path, and it always works.
- **Sessions**: Better Auth, running inside the API, issues, verifies, renews and revokes every session.

**UI vocabulary** (constitution VII, one word per concept): the UI says **llave de acceso**, never "passkey" or "FIDO". That is the term Android and iOS use in their own system prompts in Spanish, so the app's word matches the dialog the phone shows. The backup is **código por correo**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign in with an email code (Priority: P1)

A staff member (admin or agent) who has no llave de acceso at hand types their email and taps "Recibir código". They receive a 6-digit code by email, type it in, and are signed in.

- **Cutover day**: this is how every existing user gets back in.
- **Afterwards**: it is the backup whenever a llave de acceso is not available, such as a borrowed phone, a lost phone, or a browser without passkey support.

**Why this priority**: On its own it replaces password sign-in and password recovery for every role, and it locks nobody out at cutover.

**Independent Test**: An existing active agent requests a code, enters it and reaches their home screen. The session renews while they stay active and ends when they sign out.

**Acceptance Scenarios**:

1. **Given** an active account, **When** the user requests a code and enters it within 5 minutes, **Then** they are signed in, and the code cannot be used again.
2. **Given** an email that belongs to no account, **When** a code is requested for it, **Then** the screen shows the same confirmation as for a real account, and no email is sent.
3. **Given** a code was requested, **When** the user enters a wrong code 3 times, **Then** that code stops working and the user is told to request a new one.
4. **Given** a code was requested, **When** the user requests a second code, **Then** only the newest code works.
5. **Given** a code older than 5 minutes, **When** it is entered, **Then** sign-in is refused and the user is offered a new code.
6. **Given** an admin who registered but never verified their email, **When** they sign in with an email code, **Then** their email counts as verified and the account becomes active.
7. **Given** a suspended account, **When** its user enters a correct code, **Then** sign-in is refused with the suspended-account message, as today.
8. **Given** a signed-in user, **When** they sign out, **Then** that session ends on the server, and its cookie cannot be replayed.
9. **Given** a verification or password-reset link sent before cutover, **When** it is opened, **Then** a page explains that passwords are gone and offers the email code.

---

### User Story 2 - Create a llave de acceso and sign in with it (Priority: P1)

After an email-code sign-in, the app offers "Crear llave de acceso", and the user may answer "Ahora no".
- **Creating it**: if they accept, the phone asks for their fingerprint, face or device PIN, and the llave de acceso is saved for their account.
- **Using it**: from then on they tap "Entrar con llave de acceso", confirm with the same gesture, and they are in. They type no email and no code.
- **Security keys**: a hardware security key (a USB, NFC or Bluetooth FIDO2 key) works the same way.

**Why this priority**: This is the sign-in the feature exists for: no secret to type, nothing to phish, two taps on a dock at noon.

**Independent Test**: An agent signs in by email code, accepts the offer, creates a llave de acceso, signs out and signs back in with it without entering an email. A llave de acceso created in dev does not sign into prod.

**Acceptance Scenarios**:

1. **Given** a user who has just signed in by email code on a device that supports passkeys, **When** they reach the app, **Then** they are offered to create a llave de acceso and can decline with "Ahora no".
2. **Given** the offer, **When** the user confirms with the device's biometric or PIN, **Then** the llave de acceso is saved to their account and listed with a name and the date it was created.
3. **Given** a user with a llave de acceso on this device, **When** they tap "Entrar con llave de acceso" and confirm, **Then** they are signed in as that account, without typing an email.
4. **Given** a phone holding llaves de acceso for two different accounts, **When** one of them signs in, **Then** the phone's own account picker lets them choose, and they land in the account they chose.
5. **Given** a llave de acceso that was removed from the account, **When** it is used, **Then** sign-in is refused, and the message offers the email code.
6. **Given** the user cancels the device's biometric prompt, **When** control returns to the app, **Then** they are back where they started with no error.
7. **Given** a FIDO2 hardware security key, **When** the user registers it and later signs in with it, **Then** it behaves exactly like a phone's llave de acceso.
8. **Given** a llave de acceso registered on dev, **When** it is offered to prod, **Then** prod does not recognize it, and the reverse holds too.
9. **Given** a user whose last sign-in was more than a day ago, **When** they try to add a llave de acceso, **Then** they are asked to sign in again first (Better Auth's fresh-session rule).

---

### User Story 3 - A new admin registers an organization without a password (Priority: P2)

An operator who wants to sell with Turistear Ya! signs up. They enter their name, email, company and phone, with no password. A 6-digit code arrives by email. Entering it verifies the address and signs them in to their new organization, where they are offered a llave de acceso.

**Why this priority**: Without it no new organization can be created once passwords are gone. It reuses Story 1's code and Story 2's offer.

**Independent Test**: A brand-new email registers, enters the code, and lands signed in as the admin of a new organization that has its default cancellation policy (D17, as today).

**Acceptance Scenarios**:

1. **Given** an unused email, **When** a person registers with name, email, company and phone, **Then** the organization and its admin are created unverified, and a code is sent to that email.
2. **Given** a pending registration, **When** the code is entered, **Then** the admin is verified, active and signed in.
3. **Given** an email that already has an account, **When** someone registers with it, **Then** registration is refused with the existing "account already exists" outcome.
4. **Given** a registration whose code expired unused, **When** the person signs in by email code later, **Then** the account is verified and activated (Story 1, scenario 6).

---

### User Story 4 - An invited agent joins without a password (Priority: P2)

An agent opens the invitation link the admin sent and sees the organization's name, as today. They enter their name, and the app tells them a code is on its way to the invited address. They enter it and are signed in, then offered a llave de acceso.

**Why this priority**: It is the only way an agent joins an organization, and it cannot keep a password field once passwords are gone.

**Independent Test**: An admin invites an agent. The agent opens the link, enters their name and then the code, and lands signed in as an agent of that organization. The invitation is accepted.

**Acceptance Scenarios**:

1. **Given** a valid pending invitation, **When** the invitee enters their name, **Then** their account is created as an agent of the inviting organization, the invitation is accepted, and a code is sent to the invited address.
2. **Given** the code from scenario 1, **When** the invitee enters it, **Then** they are signed in and offered a llave de acceso (Story 2).
3. **Given** an invitation that was sent before cutover and has not expired, **When** it is opened after cutover, **Then** it works with the new flow, and nobody needs to be re-invited.
4. **Given** an expired, used or unknown invitation, **When** it is opened, **Then** it is refused as today.

---

### User Story 5 - Manage my llaves de acceso and sessions (Priority: P2)

From their account surface, a staff member sees every llave de acceso on their account, with its name and the date it was created.
- They can rename or remove any of them.
- They can sign out of every device at once.
- When a llave de acceso is added or removed, they receive an email telling them so.

**Why this priority**: Phones are lost, replaced and shared in the field. This is how a user cuts off a lost phone. It hardens the feature, but sign-in does not depend on it.

**Independent Test**: A user with two llaves de acceso removes one. Signing in with the removed one fails, the other works, and a notice email is sent. "Cerrar sesión en todos los dispositivos" ends a second browser's session.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open their llaves de acceso, **Then** they see each one's name and creation date.
2. **Given** a signed-in user, **When** they rename or remove one of their llaves de acceso, **Then** the change applies to that one only. Removing the last one is allowed, because the email code still signs in.
3. **Given** a user who lost their phone, **When** they sign in by email code on a new phone and remove the old llave de acceso, **Then** the old phone can no longer sign in.
4. **Given** a user signed in on two devices, **When** they sign out everywhere, **Then** both sessions end at their next request.
5. **Given** a llave de acceso is added or removed, **When** the change completes, **Then** an email notice is sent to the account's address. The change does not depend on that email being delivered (constitution VIII).

---

### Edge Cases

- **Browser without passkey support** (old Android WebView, an in-app browser opened from WhatsApp or a mail app): the llave de acceso option is hidden or explained, and the email code always works.
- **Borrowed or shared computer**: the user signs in by code and answers "Ahora no" to the offer, or saves the llave de acceso on their own phone (by scanning the code the browser shows) or on a security key.
- **Email provider down**:
  - Users with a llave de acceso, and users already signed in, are unaffected.
  - A code request still answers with the usual confirmation, because Better Auth sends in the background. No code arrives, and the user can request another after the limit window.
  - This is the "what breaks when it is down" record constitution VIII requires.
- **Code requested repeatedly**: Better Auth's limiter allows 3 code requests per minute from one address, then answers "too many requests" with the seconds to wait.
- **Old links after cutover**: a magic-link verification link (`/verify`) or a password-reset link (`/reset-password`) sent before cutover opens a page that explains that passwords are gone and offers the email code. A deep link never breaks into a blank screen.
- **Account suspended or deleted while a session is live**: the next request is refused, as today.
- **A llave de acceso shows signs of being cloned** (the authenticator reports fewer uses than the server has already seen): the sign-in is refused, and the user is told to use an email code.
- **Same phone, two accounts**: each account's llave de acceso is separate, and removing one never affects the other.
- **Invitee who never enters the code**: accepting the invitation already created the account and consumed the invitation. The invitee signs in later by requesting an email code on the sign-in screen (Story 1); nobody needs to re-invite them.

## Requirements *(mandatory)*

### Functional Requirements

**Llave de acceso (passkey / FIDO2)**

- **FR-001**: Users MUST be able to sign in with a llave de acceso without typing their email. The device offers the accounts it holds for this product.
- **FR-002**: The system MUST accept both phone and computer passkeys (synced or kept on one device) and roaming FIDO2 security keys (USB, NFC, Bluetooth). Every creation and sign-in MUST ask the device to verify the user (biometric, device PIN or pattern).
- **FR-003**: A llave de acceso MUST belong to the environment where it was created. One registered in local or dev MUST NOT sign into prod, and the reverse.
- **FR-004**: An account MUST be able to hold several llaves de acceso, each with a user-editable name and a creation date.
- **FR-005**: Adding a llave de acceso MUST require a recent sign-in, within the last day (Better Auth's fresh-session rule). Otherwise the user signs in again first.
- **FR-006**: The system MUST refuse a llave de acceso that is unknown or was removed, that belongs to a suspended account, or whose use count, when the device reports one, runs behind what the server last recorded (a sign of cloning).
- **FR-007**: After an email-code sign-in on a device that supports passkeys, the app MUST offer to create a llave de acceso, and the user MUST be able to decline.

**Email code (backup and recovery)**

- **FR-010**: Users MUST be able to request a sign-in code by email. The code MUST be 6 digits, single-use and valid for 5 minutes, and a newer code MUST supersede the previous one.
- **FR-011**: A code MUST stop working after 3 wrong attempts.
- **FR-012**: Code requests and sign-in attempts MUST be rate-limited by Better Auth's limiter, with its counts kept in the database so every Worker instance shares them. A refused request MUST tell the client how many seconds to wait.
- **FR-013**: The response to a code request MUST be identical whether or not the email belongs to an account, and no email MUST be sent to an address without one.
- **FR-014**: The code email MUST be es-MX product copy. It MUST state the code, that it lasts 5 minutes, and that Turistear Ya! will never ask for it by phone or WhatsApp.
- **FR-015**: A successful email-code sign-in MUST mark an unverified account's email as verified and activate it.
- **FR-016**: The system MUST store codes only in a form that cannot be read back from the database alone.

**Sessions**

- **FR-020**: The API MUST issue, renew and revoke every session itself, through Better Auth running in the Worker, with no external authentication service. Sessions MUST live in HttpOnly cookies, and no response body MUST carry the session token. The API strips it from Better Auth's sign-in answers and does not expose Better Auth's session-reading routes over HTTP (constitution IV).
- **FR-021**: A session MUST be honored only after the API verifies it issued it, using a signing key unique to each environment (constitution VIII). A session cookie that was altered, minted elsewhere, or comes from another environment MUST be refused with `UNAUTHORIZED`.
- **FR-022**: A session MUST last 7 days without use, and MUST be renewed by use (Better Auth's defaults).
- **FR-023**: Signing out MUST end the session on the server, so its cookie can never be used again.
- **FR-024**: Users MUST be able to end all of their sessions at once; each one ends at its next request.
- **FR-025**: A suspended or deleted account MUST be refused at its next request, as today.

**Registration and invitations**

- **FR-030**: A new admin MUST register with name, email, company name and phone, with no password, and then sign in with an email code that verifies the address. The new organization MUST be born with the default cancellation policy (D17), as today.
- **FR-031**: An invited agent MUST complete an invitation with their name. The account is created, a code is sent to the invited address, and entering it signs them in.
- **FR-032**: Invitations issued before cutover MUST stay valid until their existing expiry.

**Management**

- **FR-040**: Users MUST be able to list, rename and remove their own llaves de acceso.
- **FR-041**: The system MUST email the account when a llave de acceso is added or removed. The email MUST be sent after the change succeeds, and its failure MUST NOT undo the change (constitution VIII).

**Retirement**

- **FR-060**: No screen MUST ask for a password: not registration, invitation, sign-in or recovery. The forgot-password and reset-password flows MUST be removed.
- **FR-061**: Stored password material MUST stop being read at cutover, and MUST be removed by the deploy that follows it. A migration runs before the code it ships with, so the cutover deploy cannot remove what the code it replaces still reads (`passkey-auth D15`).
- **FR-062**: Every environment (local, dev, prod) MUST run with no binding to, configuration for, or call to Agnostic Auth, and no token it issued MUST be honored after cutover.
- **FR-063**: Links issued before cutover for email verification or password reset MUST land on a page that explains the change and offers the email code.
- **FR-064**: A fresh local checkout MUST be able to sign in without any external service. In local development the email code MUST be readable without a real mailbox.

**Error outcomes**

- **FR-070**: Routes under `/api/auth/*` belong to Better Auth.
  - They answer in its format, `{ "code", "message" }`, with its codes.
  - The app handles at least `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`, `PASSKEY_NOT_FOUND`, `AUTHENTICATION_FAILED`, `CHALLENGE_NOT_FOUND`, `SESSION_NOT_FRESH` (403, the fresh-session rule) and `ACCOUNT_SUSPENDED` (403, raised by our session-creation hook in Better Auth's format), plus HTTP `429` with `X-Retry-After`.
  - Every other route keeps `{ "error": { "code", "message" } }` (constitution IV, amended).
- **FR-071**: The codes `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` MUST be retired, because no password exists to be wrong and email-code sign-in verifies the address.

### Key Entities *(include if feature involves data)*

- **Account (user)**: an existing staff member (admin or agent), identified by a globally unique email. It gains an email-verified flag, llaves de acceso and sessions, and loses its password material. It is tenant-scoped by `organization_id`, as today. That field, the role and the status are never writable through Better Auth's routes.
- **Llave de acceso**: Better Auth's passkey record. It belongs to one account and holds the credential id, public key, name, use count, device type and creation date. It is scoped transitively through its account.
- **Email code**: Better Auth's verification record for a pending code. It holds the code, unreadable without the server's secret, plus its expiry and attempt count. It is keyed by email, a globally unique key.
- **Session**: Better Auth's session record. It holds one signed-in device for one account, with its expiry. It is scoped transitively through its account.
- **Rate-limit counter**: Better Auth's rate-limit record. It holds one counter per client address and route.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A returning staff member with a llave de acceso on their phone goes from the sign-in screen to their home screen in under 10 seconds, with one tap plus the phone's biometric or PIN.
- **SC-002**: A staff member signs in by email code in under 2 minutes, and 95% of codes reach the inbox within 1 minute.
- **SC-003**: Zero requests reach Agnostic Auth after cutover, and no environment's configuration references it.
- **SC-004**: Sign-up, sign-in, invitation acceptance, session renewal and sign-out all work with no external authentication service. A test suite runs them all with no Agnostic Auth binding configured.
- **SC-005**: 100% of altered sessions, sessions minted elsewhere and sessions from another environment are refused.
- **SC-006**: No screen asks for a password on cutover day, and no password material remains in either database after the deploy that follows it.
- **SC-007**: On cutover day every active admin and agent can sign in by email code. Nobody needs a new invitation.
- **SC-008**: After every email-code sign-in on a passkey-capable device, the app offers to create a llave de acceso.
- **SC-009**: Within 30 days of cutover, at least 70% of staff sign-ins use a llave de acceso rather than an email code.
- **SC-010**: Guessing an email code succeeds with probability no greater than 3 in 1,000,000 per code issued.
- **SC-011**: A fresh worktree signs in locally with no external worker. Its `.dev.vars` needs only `BETTER_AUTH_SECRET` beside the local origins it already sets.

## Scope Boundary

This feature changes how admins and agents prove who they are. Nothing about what they may do once signed in changes. The mechanical test:

- **API suites outside `api-turistear/test/auth/` MUST pass with no business assertion edited.** In those files, a diff may touch only the lines that obtain a session. Today 61 of 76 API test files get one from `test/helpers/jwt.ts`. One file, `test/staff/staff-management.test.ts`, may also drop its Agnostic Auth stub.
- **`api-turistear/test/auth/`** is rewritten for the new flows. Each retired password scenario is recorded as withdrawn, with its replacement.
- **App suites outside `app-turistear/src/features/auth/`** and the auth pages MUST pass unedited.
- **Out of scope**:
  - roles and permissions
  - an admin restoring an agent's access (Clarifications)
  - making a llave de acceso mandatory
  - letting users change their email
  - social sign-in (Google or Apple accounts)
  - SMS or WhatsApp codes

## Assumptions

- **Hard cutover, no password grace period.** Existing password hashes can only be checked by Agnostic Auth, so passwords stop working at cutover. Existing users cross over by email code (Story 1). Their email is already the root of trust for today's password recovery.
- **The UI term is "llave de acceso"**, matching what Android and iOS show in Spanish. "Passkey" and "FIDO" appear only in code and docs.
- **Resend stays the email provider** and moves onto the sign-in path. What breaks when it is down is recorded in Edge Cases (constitution VIII).
- **Supported devices**: agents' phones are recent enough to hold passkeys (Android 9+ with current Google Play services, iOS 16+). Older devices keep working on the email code.
- **No attestation requirement**: any FIDO2-certified or platform authenticator is accepted. The product does not restrict authenticator makes or models.
- **Better Auth standards, accepted as they come** (Clarifications, 2026-10-07):
  - The device is *asked* to verify the user. Better Auth does not refuse a sign-in whose authenticator skipped it, and phone passkeys always verify.
  - Limits are per client address, not per email.
  - The session cookie, codes and the passkey table follow its schema.
- **End-to-end journeys**: `app-turistear/e2e/setup/auth.setup.ts` signs in with a password today. It moves to the new sign-in, using a virtual authenticator.
- **The constitution was amended in this pull request** (`/speckit-constitution`, 2026-10-07): v1.2.0 (MINOR), then v1.2.1 (PATCH, keeping the BFF). The amendment covers:
  - **Principle IV**: `/api/auth/*` is served by Better Auth's handler, with its validation, its `{ code, message }` format and its codes. Every other route keeps the `routes/<resource>/` rule and the `ApiError` envelope. Session cookies are Better Auth's, still HttpOnly on `.turistearya.com`. No response body carries the token: the API strips it from the sign-in answers, and `/get-session` and `/list-sessions` are not exposed (v1.2.1).
  - **Principle VI**: the `AGNOSTIC_AUTH_API` stand-in leaves.
  - **Principle VIII**: Agnostic Auth leaves the list of services we do not own, and Resend's place on the sign-in path is recorded.
  - **The stack table**: the "Auth" row and the `nodejs_als` flag.
- **Archived stories replaced**: admin registration, verification and login, the auth middleware scenarios, agent invitation acceptance and password recovery (today's `test/auth/` suites). Their citations stay intact in the archive (constitution I).
