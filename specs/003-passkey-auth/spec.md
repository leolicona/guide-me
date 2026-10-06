# Feature Specification: Passkey Sign-In with Email Code Recovery

**Feature Branch**: `claude/webauth-passkeys-fido-auth-ylusuh`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Dejamos agnostic auth. En adelante, la autenticación debe hacerse con webauth, passkyes, FIDO y correo mas OTP como método de recuperación o respaldo."

## Clarifications

### Session 2026-10-06

- Q: After a sign-in by email code, is creating a llave de acceso optional or mandatory, and do admins get a stricter rule? → A: **Mandatory for every role alike.** The user must create one before continuing, except on a device that cannot. The email code is only for recovery (FR-007, FR-008, FR-009).
- Q: Shift operators (affiliate cashiers with no email) open shifts with a link and a 4-digit PIN. Do they move to llaves de acceso? → A: **Out of scope.** *Superseded the same day.* Affiliates and their shift operators were retired from the code (`specs/001-retire-affiliates`, #154). No operator flow remains, so no PIN depends on Agnostic Auth any more, and this feature retires Agnostic Auth entirely (FR-062). The withdrawn requirement that kept the operator flow unchanged was FR-050.
- Q: Which roles does this feature cover? → A: **Only the roles that exist: `admin` and `agent`.** The `affiliate` role is retired (constitution III, `retire-affiliates D3`). A user row still stored with a retired role stays refused at authentication, whichever way it signs in.
- Q: What implements the authentication? → A: **Better Auth** (developer's decision). It is an authentication library that runs inside the API Worker, not a service we call. The requirements below stay the contract. Better Auth is configured and extended to meet them, and where its defaults fall short, the requirement wins. The "Built on Better Auth" assumption lists those gaps for `/speckit-plan`.

### Amended by the plan (2026-10-06)

- **FR-061 and SC-006: when the passwords go.** Password material is removed by the deploy that follows cutover, not by cutover itself. The cutover's migration runs before its code, and the code it replaces still reads the columns (`passkey-auth D16`, the same path as `specs/001-retire-affiliates` → `specs/002-drop-affiliate-tables`).
- **FR-070: a cloned passkey.** It answers `PASSKEY_VERIFICATION_FAILED`, not `PASSKEY_NOT_RECOGNIZED`. The use-count check sits inside the WebAuthn verifier and cannot be told apart from a bad signature (`passkey-auth` research R9). The user sees the same thing either way: an offer of the email code.

## Context — what is broken today

Staff (admins and agents) sign in with an email and a password. Everything that proves who they are goes through Agnostic Auth, a service we do not own (constitution VIII):

- **Six of its operations sit on our critical path**: password hashing, password verification, magic-link issue and verification, session renewal and session revocation. **Eight entry points** call it directly: register, verify (GET and POST), login, logout, invite completion, password reset and session renewal. Every authenticated request needs it once its 10-minute access token has expired. When it is unreachable nobody can sign in, sign up, accept an invitation or reset a password, and no session renews. A sale cannot start without a session, so its outage stops sales.
- **Dev and prod share one auth realm.** `api-turistear/wrangler.jsonc` points both environments at the production service with the same app id ("Shared auth realm"). This contradicts constitution VIII ("no two environments share a signing secret").
- **The secret is a password**: typed on a phone, outdoors, one-handed, phishable and reusable. Forgetting it opens an 8-scenario recovery flow by email (`test/auth/password-recovery.test.ts`). In practice the email already is the root of trust. The password only adds friction on top of it.
- **Local development cannot sign in** without the external worker: CLAUDE.md warns that a fresh worktree gets "200 and no session".

This feature retires passwords and Agnostic Auth. Staff sign in with a **passkey**, the WebAuthn/FIDO2 credential their phone or security key protects with a fingerprint, face or device PIN. Holding one is mandatory. An **email code**, a one-time code sent to the user's address, is the recovery path. It is the everyday path only on a device that cannot hold a passkey. The API itself issues, verifies, renews and revokes every session, using Better Auth, which runs in-process.

**UI vocabulary** (constitution VII, one word per concept): the UI says **llave de acceso**, never "passkey" or "FIDO". That is the term Android and iOS use in their own system prompts in Spanish, so the app's word matches the dialog the phone shows. The recovery path is **código por correo**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign in with an email code (Priority: P1)

A staff member (admin or agent) who cannot use a llave de acceso right now types their email and taps "Recibir código". Maybe they have none yet, lost their phone, or are on a device that cannot hold one. They receive a 6-digit code by email, type it in, and are signed in. On cutover day this is how every existing user gets back in. Afterwards it is the recovery path. On a device that can hold a llave de acceso, the user goes straight to creating one (Story 2) before seeing any other screen.

**Why this priority**: It is the bridge that locks nobody out at cutover, and the only recovery once passwords are gone. With Story 2 it forms the MVP that lets passwords and Agnostic Auth go.

**Independent Test**: An existing active agent with no llave de acceso, using a browser without passkey support, requests a code, enters it, and reaches their home screen. Their session renews while they stay active and ends when they sign out.

**Acceptance Scenarios**:

1. **Given** an active account, **When** the user requests a code for its email and enters the code within 10 minutes, **Then** they are signed in. The code cannot be used again.
2. **Given** an email that belongs to no account, **When** a code is requested for it, **Then** the screen shows the same confirmation as for a real account, and no email is sent.
3. **Given** a code was requested, **When** the user enters a wrong code 5 times, **Then** that code stops working and the user is told to request a new one.
4. **Given** a code was requested, **When** the user requests a second code, **Then** only the newest code works.
5. **Given** a code older than 10 minutes, **When** it is entered, **Then** sign-in is refused and the user is offered a new code.
6. **Given** an admin who registered before cutover but never verified their email, **When** they sign in with an email code, **Then** their email counts as verified and the account becomes active.
7. **Given** a suspended account, **When** its user enters a correct code, **Then** sign-in is refused with the suspended-account message, as today.
8. **Given** a user row still stored with a retired role (`affiliate`), **When** a correct code is entered for its email, **Then** sign-in is refused and no session is issued (`retire-affiliates D3`).
9. **Given** a signed-in user, **When** they sign out, **Then** that session ends on the server, and its cookies cannot be replayed to renew it.

---

### User Story 2 - Create a llave de acceso and sign in with it (Priority: P1)

Right after an email-code sign-in, a staff member is asked to create a llave de acceso, and they cannot skip it. The phone asks for their fingerprint, face or device PIN, and the llave de acceso is saved for their account. From then on they open the app, tap "Entrar con llave de acceso", confirm with the same gesture, and they are in. They type no email and no code. A hardware security key (a USB, NFC or Bluetooth FIDO2 key) works the same way.

**Why this priority**: This is the sign-in the feature exists for: no secret to type, nothing to phish, two taps on a dock at noon. Making it mandatory keeps the email code from becoming everyday sign-in.

**Independent Test**: An agent signs in by email code and is taken to the creation step. They create a llave de acceso, sign out, and sign back in with it without entering an email. A llave de acceso created in dev does not sign into prod.

**Acceptance Scenarios**:

1. **Given** a user who has just signed in by email code on a device that can hold a llave de acceso, **When** the code is accepted, **Then** the next screen is the creation step, with no way to skip it. Any other request from that session is refused until a llave de acceso is created or the user signs out.
2. **Given** the creation step, **When** the user confirms with the device's biometric or PIN, **Then** the llave de acceso is saved to their account, listed with a name, its creation date and "never used", and the user reaches their home screen.
3. **Given** the creation step on a computer that is not theirs, **When** the user chooses to save the llave de acceso on their own phone (by scanning the code the browser shows) or on a security key, **Then** nothing is stored on the borrowed computer, and the step counts as completed.
4. **Given** a user signed in by email code on a device that cannot hold a llave de acceso, **When** the code is accepted, **Then** they reach their home screen without the creation step. Their next email-code sign-in from a capable device requires it.
5. **Given** a user with a llave de acceso on this device, **When** they tap "Entrar con llave de acceso" and confirm, **Then** they are signed in as that account. They did not type an email.
6. **Given** a phone holding llaves de acceso for two different accounts, **When** one of them signs in, **Then** the phone's own account picker lets them choose, and they land in the account they chose.
7. **Given** a llave de acceso that was removed from the account, **When** it is used, **Then** sign-in is refused with a message that offers the email code.
8. **Given** the user cancels the device's biometric prompt, **When** control returns to the app, **Then** they are back where they started with no error. On the sign-in screen both options are still offered. On the creation step they can retry or sign out.
9. **Given** a FIDO2 hardware security key, **When** the user registers it and later signs in with it, **Then** it behaves exactly like a phone's llave de acceso.
10. **Given** a llave de acceso registered on dev, **When** it is offered to prod, **Then** prod does not recognize it. The reverse holds too.

---

### User Story 3 - A new admin registers an organization without a password (Priority: P2)

An operator who wants to sell with Turistear Ya! signs up. They enter their name, email, company and phone, with no password. A 6-digit code arrives by email, and entering it activates the account. They then create their llave de acceso, as in Story 2, and land in their new organization.

**Why this priority**: Without it no new organization can be created once passwords are gone. It reuses Story 1's code and Story 2's creation step.

**Independent Test**: A brand-new email registers, confirms the code, creates a llave de acceso, and lands signed in as the admin of a new organization that has its default cancellation policy (D17, as today).

**Acceptance Scenarios**:

1. **Given** an unused email, **When** a person registers with name, email, company and phone, **Then** the organization and its admin are created unverified, and a code is sent to that email.
2. **Given** a pending registration, **When** the code is entered, **Then** the admin is active and goes through the mandatory creation step of Story 2.
3. **Given** an email that already has an account, **When** someone registers with it, **Then** registration is refused with the existing "account already exists" outcome.
4. **Given** a registration whose code expired unused, **When** the person signs in by email code later, **Then** the account is verified and activated (Story 1, scenario 6).

---

### User Story 4 - An invited agent joins without a password (Priority: P2)

An agent opens the invitation link the admin sent and sees the organization's name, as today. They enter their name and create their llave de acceso, and they are signed in.

**Why this priority**: It is the only way an agent joins an organization, and it cannot keep a password field once passwords are gone.

**Independent Test**: An admin invites an agent. The agent opens the link, enters their name, and creates a llave de acceso. They land signed in as an agent of that organization, and the invitation is marked accepted.

**Acceptance Scenarios**:

1. **Given** a valid pending invitation, **When** the invitee enters their name and creates a llave de acceso, **Then** their account is created as an agent of the inviting organization, the invitation is accepted, and they are signed in.
2. **Given** a valid pending invitation opened in a browser that cannot create a llave de acceso (for example an in-app browser opened from WhatsApp or a mail app), **When** the invitee enters their name, **Then** the account is still created and they are signed in. The app explains that they will create their llave de acceso the next time they sign in from a full browser (Story 2, scenario 4).
3. **Given** an invitation that was sent before cutover and has not expired, **When** it is opened after cutover, **Then** it works with the new flow. Nobody needs to be re-invited.
4. **Given** an expired, used or unknown invitation, **When** it is opened, **Then** it is refused as today.

---

### User Story 5 - Manage my llaves de acceso and sessions (Priority: P2)

From their account surface, a staff member sees every llave de acceso on their account with its name, when it was created and when it was last used. They can add more, and rename or remove any except the last one. They can sign out of every device at once. When a llave de acceso is added or removed, they receive an email telling them so.

**Why this priority**: Phones are lost, replaced and shared in the field. Without this a user cannot clean up a lost phone's access. It hardens the feature, but sign-in does not need it.

**Independent Test**: A user with two llaves de acceso removes one. Signing in with the removed one fails, signing in with the other works, and a notice email is sent. Removing the remaining one is refused. "Cerrar sesión en todos los dispositivos" ends a second browser's session.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they open their llaves de acceso, **Then** they see each one's name, creation date and last-used date.
2. **Given** a user who last authenticated more than 15 minutes ago, **When** they try to add or remove a llave de acceso, **Then** they must first confirm with an existing llave de acceso or a fresh email code.
3. **Given** a user with exactly one llave de acceso, **When** they try to remove it, **Then** the removal is refused and they are told to add another one first.
4. **Given** a user who lost their phone, **When** they sign in by email code on a new phone, create a llave de acceso there and remove the old one, **Then** only the new one signs in.
5. **Given** a user signed in on two devices, **When** they sign out everywhere, **Then** both sessions end at their next request.
6. **Given** a llave de acceso is added or removed, **When** the change completes, **Then** an email notice is sent to the account's address. The change does not depend on that email being delivered (constitution VIII).

---

### User Story 6 - An admin restores an agent's access (Priority: P3)

An agent's phone is stolen. The admin opens that agent in the team list and taps "Restablecer acceso". This removes every llave de acceso of that agent and ends all of their sessions. The agent signs in again by email code from their new phone, and the mandatory creation step gives them a new llave de acceso.

**Why this priority**: A stolen phone with a live session is a stolen till. The admin can already suspend an agent today, so this adds a gentler and faster recovery rather than filling a gap.

**Independent Test**: An admin restores access for one of their agents. The agent's existing session is refused at its next request, and the agent's old llave de acceso no longer signs in. An admin of another organization gets "not found" for the same agent.

**Acceptance Scenarios**:

1. **Given** an admin and an agent of the same organization, **When** the admin restores that agent's access, **Then** all of the agent's llaves de acceso are removed, all of their sessions end, and they receive an email notice.
2. **Given** an admin of organization A, **When** they try to restore access for an agent of organization B, **Then** the answer is "not found" and nothing changes (constitution III, proven with `seedTwoOrgs`).
3. **Given** an agent, **When** they try to restore someone else's access, **Then** it is forbidden.

---

### Edge Cases

- **Browser without passkey support** (old Android WebView, an in-app browser opened from WhatsApp or a mail app): the llave de acceso option is hidden or explained. The email code always works there, and the creation requirement waits until the user signs in from a capable device.
- **Borrowed or shared computer**: the creation step lets the user save the llave de acceso on their own phone or on a security key, so a device that is not theirs never holds it (Story 2, scenario 3).
- **Email provider down**: users with a llave de acceso and users already signed in are unaffected. Users who need a code cannot sign in until it recovers, and the screen says the code could not be sent rather than claiming success. This is the "what breaks when it is down" record constitution VIII requires.
- **Code requested repeatedly**: a new code can be requested once a minute, at most 5 times per hour per email. Beyond that the user waits, and the screen says how long.
- **Old links after cutover**: a magic-link verification link (`/verify`) or a password-reset link (`/reset-password`) sent before cutover opens a page that explains that passwords are gone and offers the email code. A deep link never breaks into a blank screen.
- **A user row with a retired role**: production keeps one `affiliate` row (`specs/001-retire-affiliates`). No sign-in path, whether llave de acceso, email code or invitation, issues it a session (`retire-affiliates D3`).
- **Many parallel requests when a session needs renewal**: renewal never signs the user out because two requests raced (BUG-014).
- **Account suspended or deleted while a session is live**: the next request is refused, as today.
- **A llave de acceso shows signs of being cloned** (the authenticator reports fewer uses than the server has already seen): the sign-in is refused, and the user is told to use an email code.
- **Same phone, two accounts**: each account's llave de acceso is separate. Removing one never affects the other.
- **Session stuck at the creation step** (the user closes the app before creating one): the next request from that session still lands on the creation step until they create one or sign out.

## Requirements *(mandatory)*

### Functional Requirements

**Llave de acceso (passkey / FIDO2)**

- **FR-001**: Users MUST be able to sign in with a llave de acceso without typing their email. The device offers the accounts it holds for this product.
- **FR-002**: The system MUST accept both phone and computer passkeys (synced across a person's devices or kept on one device) and roaming FIDO2 security keys (USB, NFC, Bluetooth). Every sign-in and every creation MUST require the device's own user verification: biometric, device PIN or pattern.
- **FR-003**: A llave de acceso MUST belong to the environment where it was created. One registered in local or dev MUST NOT sign into prod, and the reverse.
- **FR-004**: An account MUST be able to hold several llaves de acceso, up to 10. Each one MUST have a user-editable name, a creation date and a last-used date.
- **FR-005**: A user MUST be able to add or remove a llave de acceso only from a signed-in session, and only if they authenticated within the last 15 minutes. Otherwise they first re-confirm with an existing llave de acceso or a fresh email code.
- **FR-006**: The system MUST refuse a llave de acceso that is unknown, was removed, belongs to a suspended account or to a retired role, or whose use count, when the device reports one, runs behind what the server last recorded (a sign of cloning).
- **FR-007**: After every email-code sign-in from a device that can hold a llave de acceso, the user MUST create one before doing anything else, whatever their role. The server MUST enforce this: until a llave de acceso is created, that session MUST be refused for every request except creating one, reading the signed-in user's own identity, and signing out.
- **FR-008**: A user MUST NOT be able to remove their own last llave de acceso. An admin's restore (FR-042) is the only way an account goes from one to none.
- **FR-009**: When the device reports that it cannot hold a llave de acceso, an email-code session MUST proceed without the creation step. The session MUST record that report.

**Email code (recovery)**

- **FR-010**: Users MUST be able to request a sign-in code by email. The code MUST be 6 digits, single-use and valid for 10 minutes, and requesting a new code MUST invalidate the previous one.
- **FR-011**: A code MUST stop working after 5 wrong attempts.
- **FR-012**: Code requests MUST be limited to 1 per minute and 5 per hour per email address. The response MUST tell the user when they can retry.
- **FR-013**: The response to a code request MUST be identical whether or not the email belongs to an account, and no email MUST be sent to an address without one.
- **FR-014**: The code email MUST be es-MX product copy. It MUST state the code, how long it lasts, and that Turistear Ya! will never ask for it by phone or WhatsApp.
- **FR-015**: A successful email-code sign-in MUST mark an unverified account's email as verified and activate it.
- **FR-016**: The system MUST store codes only in a form that cannot be read back as the code, and MUST compare them in constant time.

**Sessions**

- **FR-020**: The API MUST issue, renew and revoke every session itself, without any external authentication service. Sessions MUST stay in HttpOnly cookies and never appear in a response body (constitution IV).
- **FR-021**: A session MUST be honored only after the API verifies that it issued it, using a signing key unique to each environment (constitution VIII). A session that was altered, was minted elsewhere, or comes from another environment MUST be refused with `UNAUTHORIZED`.
- **FR-022**: A session MUST stay valid for as long as the user keeps using it, within the current idle window of 60 days of inactivity, and MUST renew silently. Parallel requests during a renewal MUST never end a valid session (BUG-014).
- **FR-023**: Signing out MUST end the session on the server, so the same cookies can never be renewed again.
- **FR-024**: Users MUST be able to end all of their sessions at once.
- **FR-025**: A suspended or deleted account, or one stored with a retired role, MUST be refused at its next request, as today (`retire-affiliates D3`). Ending a session (sign-out, sign-out everywhere, access restore) MUST take effect at that session's next request.

**Registration and invitations**

- **FR-030**: A new admin MUST register with name, email, company name and phone, with no password. The account MUST become active when an email code sent to that address is confirmed, and FR-007 then applies. The new organization MUST be born with the default cancellation policy (D17), as today.
- **FR-031**: An invited agent MUST complete an invitation with their name and a llave de acceso. Opening the invitation link sent to their email counts as proof of that address. If the browser cannot create a llave de acceso, the invitee MUST be able to complete the invitation without one, and FR-009 applies.
- **FR-032**: Invitations issued before cutover MUST stay valid until their existing expiry.

**Management and recovery**

- **FR-040**: Users MUST be able to list, add, rename and remove their own llaves de acceso, within FR-004, FR-005 and FR-008.
- **FR-041**: The system MUST email the account when a llave de acceso is added or removed and when an admin restores the account's access. The email MUST be sent after the change succeeds, and its failure MUST NOT undo the change (constitution VIII).
- **FR-042**: An admin MUST be able to restore access for any agent of their own organization: remove all of that agent's llaves de acceso and end all of their sessions. For an agent of another organization the answer MUST be "not found" (constitution III).

**Retirement**

- **FR-060**: No screen MUST ask for a password: registration, invitation, sign-in and recovery. The forgot-password and reset-password flows MUST be removed.
- **FR-061**: Stored password material MUST stop being read at cutover, and MUST be removed by the deploy that follows it. A migration runs before the code it ships with, so the cutover deploy cannot remove what the code it replaces still reads (`passkey-auth D16`).
- **FR-062**: Every environment (local, dev, prod) MUST run with no binding to, configuration for, or call to Agnostic Auth. No token it issued MUST be honored after cutover.
- **FR-063**: Links issued before cutover for email verification or password reset MUST land on a page that explains the change and offers the email code.
- **FR-064**: A fresh local checkout MUST be able to sign in without any external service. In local development the email code MUST be readable without a real mailbox.

**Error outcomes** (constitution IV declares each code here before it exists in code)

- **FR-070**: Failures MUST answer `{ error: { code, message } }` with these codes. The existing ones are `UNAUTHORIZED` (401), `ACCOUNT_SUSPENDED` (403), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `INVALID_TOKEN` (400, invitations) and `EMAIL_ALREADY_EXISTS` (409). The new ones are:
  - `PASSKEY_NOT_RECOGNIZED` (401): the llave de acceso is unknown or was removed.
  - `PASSKEY_VERIFICATION_FAILED` (401): the challenge expired, the origin is wrong, the signature is invalid, the device did not verify the user, or the use count went backwards (a sign of cloning).
  - `PASSKEY_ENROLLMENT_REQUIRED` (403): the session must create a llave de acceso first (FR-007).
  - `PASSKEY_LAST_ONE` (409): the user tried to remove their only llave de acceso (FR-008).
  - `PASSKEY_LIMIT_REACHED` (409): the account already has 10 llaves de acceso.
  - `OTP_INVALID` (401): the code is wrong, expired, already used or superseded.
  - `OTP_ATTEMPTS_EXCEEDED` (429): 5 wrong attempts. A new code is required.
  - `OTP_RATE_LIMITED` (429): the request limit was reached. The response carries the retry time.
  - `OTP_DELIVERY_FAILED` (503): the email provider refused the send. The user is told the code was not sent.
  - `REAUTH_REQUIRED` (403): the step-up from FR-005 is needed.
- **FR-071**: The codes `INVALID_CREDENTIALS` and `EMAIL_NOT_VERIFIED` MUST be retired, because no password exists to be wrong and email-code sign-in verifies the address.

### Key Entities *(include if feature involves data)*

- **Account (user)**: an existing staff member, admin or agent, identified by a globally unique email. It loses its password material and gains llaves de acceso and sessions. It is tenant-scoped by `organization_id`, as today.
- **Llave de acceso (credential)**: a public-key credential that belongs to one account. It records the credential's identifier and public key, a user-editable name, its kind (synced passkey or security key, when the device reports it), its use count, and its creation and last-used dates. It is tenant-scoped transitively through its account, and the migration says so (constitution III).
- **Email code**: a pending sign-in code for one email address. It records the code in a non-readable form, its expiry, its wrong-attempt count and whether it was used. It is looked up by a globally unique key (the email), so it is exempt from organization filtering, as `users.email` is today.
- **Sign-in challenge**: a single-use, short-lived random value the server issues for each llave de acceso ceremony (creation or sign-in) and consumes when it verifies the answer.
- **Session**: one signed-in device for one account. It records:
  - when it was created, last renewed and last authenticated (for FR-005)
  - how it was authenticated: llave de acceso or email code
  - whether it still owes the creation step (FR-007), or the device reported it cannot hold a llave de acceso (FR-009)
  - when it expires, and whether it was ended

  It is scoped transitively through its account.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A returning staff member with a llave de acceso on their phone goes from the sign-in screen to their home screen in under 10 seconds, with one tap plus the phone's biometric or PIN.
- **SC-002**: A staff member recovering by email code is signed in, with their new llave de acceso created, in under 3 minutes, and 95% of codes reach the inbox within 1 minute.
- **SC-003**: Zero requests reach Agnostic Auth after cutover, and no environment's configuration references it.
- **SC-004**: Sign-up, sign-in, invitation acceptance, session renewal and sign-out all work with no external authentication service. A test suite runs them all with no Agnostic Auth binding configured.
- **SC-005**: 100% of altered sessions, sessions minted elsewhere and sessions from another environment are refused.
- **SC-006**: No screen asks for a password on cutover day, and no password material remains in either database after the deploy that follows it.
- **SC-007**: On cutover day every active admin and agent can sign in by email code. Nobody needs a new invitation.
- **SC-008**: 100% of email-code sign-ins on a device able to hold a llave de acceso end with one created before any other screen is reached.
- **SC-009**: Within 30 days of cutover, at least 90% of staff sign-ins use a llave de acceso rather than an email code.
- **SC-010**: Guessing an email code succeeds with probability no greater than 5 in 1,000,000 per code issued, and no more than 5 codes per hour can be issued for one address.
- **SC-011**: A fresh worktree signs in locally with no `.dev.vars` auth setup and no external worker.

## Scope Boundary

This feature changes how admins and agents prove who they are. Nothing about what they may do once signed in changes. The mechanical test:

- **API suites outside `api-turistear/test/auth/` MUST pass with no business assertion edited.** In those files, a diff may touch only the lines that obtain a session. Today 65 of 75 API test files get one from `test/helpers/jwt.ts`. One file, `test/staff/staff-management.test.ts`, may also drop its Agnostic Auth stub.
- **`api-turistear/test/auth/`** is rewritten for the new flows. Each retired password scenario is recorded as withdrawn, with its replacement. The retired-role refusal (`retire-affiliates D3`) keeps a test on every new sign-in path.
- **App suites outside `app-turistear/src/features/auth/`** and the auth pages MUST pass unedited.
- **Out of scope**:
  - roles and permissions, including bringing back any role retired by `specs/001-retire-affiliates`
  - the retired affiliate tables (debt `affiliate-tables`)
  - letting users change their email
  - social sign-in (Google or Apple accounts)
  - SMS or WhatsApp codes

## Assumptions

- **Hard cutover, no password grace period.** Existing password hashes can only be checked by Agnostic Auth, so passwords stop working at cutover. Existing users cross over by email code (Story 1) and create their llave de acceso there (Story 2). Their email is already the root of trust for today's password recovery.
- **Device capability is reported by the client.** The server cannot prove that a device lacks passkey support. It records the client's report (FR-009). A client that falsely reports no support gains nothing beyond what the email code already granted: it only skips the creation step.
- **The UI term is "llave de acceso"**, matching what Android and iOS show in Spanish. "Passkey" and "FIDO" appear only in code and docs.
- **The session idle window stays at 60 days of inactivity**, the value configured today (`SESSION_REFRESH_TTL_SECONDS` = 5,184,000). Session cookies keep their HttpOnly, `.turistearya.com` scope (constitution IV).
- **Resend stays the email provider.** It moves onto the recovery path. What breaks when it is down is recorded in Edge Cases (constitution VIII).
- **Supported devices**: agents' phones are recent enough to hold passkeys (Android 9+ with current Google Play services, iOS 16+). Older devices keep working on the email code (FR-009) and are not locked out.
- **No attestation requirement**: any FIDO2-certified or platform authenticator is accepted. The product does not restrict authenticator makes or models.
- **End-to-end journeys** (`app-turistear/e2e/setup/auth.setup.ts` signs in with a password today) move to the new sign-in, using a virtual authenticator or the email code read in a test environment.
- **Built on Better Auth** (Clarifications). Its current stable release is 1.7.7 (2026-09-30), with email OTP in core and passkeys in the separate `@better-auth/passkey` package. Read against that release, it already covers:
  - username-less passkey sign-in, and passkey creation for a user with no session yet (for invitations)
  - list, rename and delete for passkeys
  - email OTP sign-in that answers the same for unknown emails when sign-up is off (FR-013)
  - sessions stored in the database and revocable, with a signed token that is not rotated on renewal (FR-021, FR-023, BUG-014)
  - D1 without interactive transactions

  Its defaults fall short of these requirements, which `/speckit-plan` must close with configuration, hooks or our own routes:

  | Requirement | Better Auth by default |
  |---|---|
  | FR-002, user verification required | Only "preferred", never enforced |
  | FR-003, passkeys bound to their environment | Depends on the rpID chosen per environment |
  | FR-005, 15-minute step-up for add and remove | Freshness is 1 day and checked on add only |
  | FR-007, FR-008 and FR-009, mandatory passkey and never removing the last one | None |
  | FR-010 and FR-011, 10-minute codes and 5 attempts | 5 minutes and 3 attempts |
  | FR-012, per-email send limits | None. Its limiter keys on IP and path, keeps its counts per isolate on Workers in memory storage, and does not apply to server-side `auth.api` calls |
  | FR-016, codes stored unreadable | Stored as plain text |
  | FR-022, 60-day idle window | 7 days |
  | FR-023 and FR-025, revocation effective at the next request | The session cookie cache must stay off |
  | FR-042, a tenant-scoped access restore | The admin plugin is global, so it is not used. Neither is the organization plugin. Organizations and roles stay ours |
  | FR-025, retired-role refusal | Needs a session-creation hook that throws |
  | FR-070, the `{ error: { code, message } }` envelope | Its errors answer `{ code, message }` at the top level |

  It also needs the Workers `nodejs_compat` flag, an `account` table even though nothing writes to it, and cookie names that differ between dev and prod, because both share `.turistearya.com`.
- **The constitution must be amended in the same pull request** (`/speckit-constitution`, a MINOR bump from v1.1.0). The amendment covers:
  - Principle IV: the API, not Agnostic Auth, issues the session tokens. The cookie names `gm_access` and `gm_refresh` give way to Better Auth's session cookie.
  - Principle VI: the `AGNOSTIC_AUTH_API` stand-in leaves the list of services stubbed in tests.
  - Principle VIII: Agnostic Auth leaves the list of services we do not own, and Resend's place on the recovery path is recorded.
  - The Technology Stack "Auth" row becomes Better Auth with its passkey and email OTP plugins, plus the `nodejs_compat` flag.

  Principle IV says every route lives in `src/routes/<resource>/` behind `zValidator` and answers the `ApiError` envelope. `/speckit-plan` must decide between two options. One is to wrap Better Auth's calls (`auth.api.*`) in our own `routes/auth/` and keep Principle IV whole. The other is to mount Better Auth's handler directly and propose the amendment.
- **Archived stories replaced**: admin registration, verification and login, the auth middleware scenarios, agent invitation acceptance and password recovery (today's `test/auth/` suites). Their citations stay intact in the archive (constitution I).
