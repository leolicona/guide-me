# Feature: Auth — Frontend Spec

## Context

This spec defines the UI screens, navigation flows, component structure, and testable scenarios for all authentication features in `app-guideme`. It covers admin registration, email verification, login, password recovery, agent invitation/onboarding, session management, and logout.

The UI never handles tokens directly — session cookies (`gm_access`, `gm_refresh`) are `HttpOnly` and managed entirely by the API via `Set-Cookie` headers.

**API Specs:**
- `docs/auth/admin-registration.spec.md`
- `docs/auth/admin-login-session.spec.md`
- `docs/auth/password-recovery.spec.md`
- `docs/auth/agent-invitation.spec.md`

**Tech Stack:** React 18, TypeScript, MUI v6, TanStack Query, Zustand, React Hook Form + Zod.  
**Design Style:** Elegant minimalist — see `CLAUDE.md` for theme principles.

---

## Folder Structure

Following the layered architecture defined in `CLAUDE.md`:

```
app-guideme/src/
├── pages/
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── VerifyPage.tsx
│   ├── ForgotPasswordPage.tsx
│   ├── ResetPasswordPage.tsx
│   ├── InviteAcceptPage.tsx
│   └── DashboardPage.tsx
├── layout/
│   └── AuthLayout.tsx          # MUI Container + Card centered layout
├── features/
│   └── auth/
│       ├── components/
│       │   ├── LoginForm.tsx
│       │   ├── RegisterForm.tsx
│       │   ├── ForgotPasswordForm.tsx
│       │   ├── ResetPasswordForm.tsx
│       │   ├── InviteCompleteForm.tsx
│       │   ├── PasswordInput.tsx
│       │   ├── PasswordStrength.tsx
│       │   ├── SuccessScreen.tsx
│       │   └── AuthGuard.tsx
│       ├── hooks/
│       │   ├── useLogin.ts
│       │   ├── useRegister.ts
│       │   ├── useVerify.ts
│       │   ├── useForgotPassword.ts
│       │   ├── useResetPassword.ts
│       │   ├── useInviteAccept.ts
│       │   ├── useInviteComplete.ts
│       │   ├── useMe.ts
│       │   └── useLogout.ts
│       ├── schemas.ts          # Zod schemas (shared with backend where possible)
│       ├── types.ts
│       └── index.ts
├── store/
│   └── authStore.ts            # Zustand: { user, isAuthenticated, setUser, clear }
├── services/
│   └── authService.ts          # fetch wrappers for /api/auth/* endpoints
└── config/
    ├── theme.ts                # MUI createTheme() — elegant minimalist
    └── routes.ts               # Route path constants
```

---

## Shared Components

### AuthLayout

Centered card layout used by all public auth pages. Built with MUI:
- `Container maxWidth="sm"` centered vertically and horizontally
- `Card` with `elevation={0}`, subtle border (`1px solid divider`), `borderRadius: 12px`
- Logo at top, title via `Typography variant="h5"`, generous padding (`p={4}`)
- Footer links slot for navigation between auth screens
- Off-white background (`grey.50`)

### AuthGuard

Route wrapper for protected pages. Uses `useMe()` (TanStack Query) to call `GET /api/me`:
- **Loading** → `CircularProgress` centered full-screen
- **Success (200)** → render children, populate `authStore` with user data
- **Error (401)** → redirect to `/login?redirect={currentPath}`

### PasswordInput

MUI `TextField` with `InputAdornment` end icon (visibility toggle). Integrates with `react-hook-form` via `Controller`.

### PasswordStrength

MUI `LinearProgress` with dynamic color (red → yellow → green) based on password strength. Non-blocking — purely informational.

### SuccessScreen

Reusable screen with MUI `Stack` layout: icon (Material Symbols), `Typography` title + body, and optional `Button`/`Link`. Used after registration, password reset, etc. Rendered inside `AuthLayout`.

---

## Validation Schemas (`features/auth/schemas.ts`)

Zod schemas used by React Hook Form via `@hookform/resolvers/zod`:

```ts
registerSchema: { name, email, password, company_name, phone }
loginSchema: { email, password }
forgotPasswordSchema: { email }
resetPasswordSchema: { password, confirmPassword (refine match) }
inviteCompleteSchema: { name, password, confirmPassword (refine match) }
```

> Note: `confirmPassword` is frontend-only — not sent to the API.

---

## Routes

| Path | Page | Type | Layout |
|---|---|---|---|
| `/login` | LoginPage | Public | AuthLayout |
| `/register` | RegisterPage | Public | AuthLayout |
| `/verify` | VerifyPage | Public | AuthLayout |
| `/forgot-password` | ForgotPasswordPage | Public | AuthLayout |
| `/reset-password` | ResetPasswordPage | Public | AuthLayout |
| `/invite/accept` | InviteAcceptPage | Public | AuthLayout |
| `/dashboard` | DashboardPage | Protected | MainLayout (AuthGuard) |

---

## Screens & Scenarios

### Screen 1 — Register (`/register`)

**API:** `POST /api/auth/register`  
**Hook:** `useRegister` → `useMutation`  
**Form:** `RegisterForm` with `react-hook-form` + `registerSchema`

#### Scenario 1.1 — Successful Registration

**Given** the user is on `/register`  
**When** they fill all fields with valid data and submit  
**Then**
- The submit button shows a spinner and becomes disabled
- All fields become readonly during the request
- On `201`, the form is replaced by `SuccessScreen` with message: "Registration successful. Check your email to verify your account."
- A mail icon is shown
- No redirect occurs — the user must check their email

#### Scenario 1.2 — Email Already Registered

**Given** the user is on `/register`  
**When** they submit with an email that already exists in the system  
**Then**
- On `409 EMAIL_ALREADY_EXISTS`, an inline error appears under the email field: "This email is already registered"
- The form remains editable
- No other fields show errors

#### Scenario 1.3 — Frontend Validation Errors

**Given** the user is on `/register`  
**When** they submit with empty or invalid fields  
**Then**
- Validation runs client-side via Zod before any API call
- Inline errors appear under each invalid field
- No API request is made

#### Scenario 1.4 — Navigation Links

**Given** the user is on `/register`  
**Then**
- A link "Already have an account? Log in" navigates to `/login`

---

### Screen 2 — Email Verification (`/verify?token=xxx`)

**API:** `GET /api/auth/verify?token=xxx`  
**Hook:** `useVerify` → `useQuery` (fires on mount)

#### Scenario 2.1 — Successful Verification

**Given** the user navigates to `/verify?token=<valid_token>`  
**Then**
- A spinner is shown with text "Verifying your account..."
- On `200`, a welcome message is shown: "Account verified, {name}!"
- After 2–3 seconds, the user is redirected to `/dashboard`
- The API sets session cookies automatically

#### Scenario 2.2 — Invalid or Expired Token

**Given** the user navigates to `/verify?token=<invalid_or_expired>`  
**Then**
- On `400 INVALID_TOKEN`, an error screen is shown: "The link is invalid or has expired"
- A link to `/register` is provided

#### Scenario 2.3 — Missing Token

**Given** the user navigates to `/verify` without a `token` query param  
**Then**
- An error screen is shown immediately (no API call): "Invalid link"
- A link to `/login` is provided

---

### Screen 3 — Login (`/login`)

**API:** `POST /api/auth/login`  
**Hook:** `useLogin` → `useMutation`  
**Form:** `LoginForm` with `react-hook-form` + `loginSchema`

#### Scenario 3.1 — Successful Login

**Given** the user is on `/login`  
**When** they enter valid credentials and submit  
**Then**
- The submit button shows a spinner
- On `200`, the user is redirected to `/dashboard` (or to the `?redirect=` param if present)
- The API sets session cookies automatically

#### Scenario 3.2 — Invalid Credentials

**Given** the user is on `/login`  
**When** they enter incorrect email or password  
**Then**
- On `401 INVALID_CREDENTIALS`, a general error banner (not inline) is shown: "Incorrect email or password"
- The error does NOT indicate whether the email or password was wrong
- The password field is cleared; the email field retains its value
- Focus moves to the password field

#### Scenario 3.3 — Unverified Account

**Given** the user is on `/login`  
**When** they enter correct credentials but their account is unverified  
**Then**
- On `403 EMAIL_NOT_VERIFIED`, a specific message is shown: "Your account has not been verified. Check your email."
- Optionally: a button to resend the verification email

#### Scenario 3.4 — Frontend Validation Errors

**Given** the user is on `/login`  
**When** they submit with empty email or password  
**Then**
- Validation runs client-side via Zod
- Inline errors appear under invalid fields
- No API request is made

#### Scenario 3.5 — Navigation Links

**Given** the user is on `/login`  
**Then**
- A link "Don't have an account? Sign up" navigates to `/register`
- A link "Forgot your password?" navigates to `/forgot-password`

---

### Screen 4 — Forgot Password (`/forgot-password`)

**API:** `POST /api/auth/forgot-password`  
**Hook:** `useForgotPassword` → `useMutation`  
**Form:** `ForgotPasswordForm` with `react-hook-form` + `forgotPasswordSchema`

#### Scenario 4.1 — Request Submitted (any email)

**Given** the user is on `/forgot-password`  
**When** they enter any valid-format email and submit  
**Then**
- On `200` (always), the form is replaced by `SuccessScreen`: "If the email is registered, you will receive instructions to reset your password."
- The **same message** is shown regardless of whether the email exists — this is a security requirement

#### Scenario 4.2 — Navigation Links

**Given** the user is on `/forgot-password`  
**Then**
- A link "Back to login" navigates to `/login`

---

### Screen 5 — Reset Password (`/reset-password?token=xxx`)

**API:** `POST /api/auth/reset-password`  
**Hook:** `useResetPassword` → `useMutation`  
**Form:** `ResetPasswordForm` with `react-hook-form` + `resetPasswordSchema`

#### Scenario 5.1 — Successful Reset

**Given** the user navigates to `/reset-password?token=<valid_token>`  
**When** they enter a new password (with confirmation) and submit  
**Then**
- On `200`, the form is replaced by `SuccessScreen`: "Password updated successfully"
- A button/link to `/login` is shown — the API does NOT set a session, the user must log in
- No automatic redirect

#### Scenario 5.2 — Invalid or Expired Token

**Given** the user navigates to `/reset-password?token=<invalid_or_expired>`  
**When** they submit the form  
**Then**
- On `400 INVALID_TOKEN`, the form is replaced by an error screen: "The link is invalid or has expired"
- A link to `/forgot-password` is provided to request a new token

#### Scenario 5.3 — Passwords Don't Match

**Given** the user is on `/reset-password`  
**When** `password` and `confirmPassword` don't match  
**Then**
- Client-side Zod validation shows inline error: "Passwords do not match"
- No API request is made

#### Scenario 5.4 — Missing Token

**Given** the user navigates to `/reset-password` without a `token` query param  
**Then**
- Error screen shown immediately: "Invalid link"
- Link to `/forgot-password`

---

### Screen 6 — Accept Invitation (`/invite/accept?token=xxx`)

**APIs:**
- `GET /api/auth/invite/accept?token=xxx` (load invitation)
- `POST /api/auth/invite/complete` (complete onboarding)

**Hooks:** `useInviteAccept` → `useQuery`, `useInviteComplete` → `useMutation`  
**Form:** `InviteCompleteForm` with `react-hook-form` + `inviteCompleteSchema`

#### Scenario 6.1 — Load Valid Invitation

**Given** the user navigates to `/invite/accept?token=<valid_token>`  
**Then**
- A spinner is shown: "Loading invitation..."
- On `200`, the invitation details are displayed (email, organization name) as readonly info
- A form is shown below with fields: `name` and `password` (+ `confirmPassword`)

#### Scenario 6.2 — Complete Onboarding Successfully

**Given** a valid invitation is loaded  
**When** the user fills `name` and `password` and submits  
**Then**
- On `200`, the user is redirected to `/dashboard`
- The API sets session cookies automatically

#### Scenario 6.3 — Invalid or Expired Invitation

**Given** the user navigates to `/invite/accept?token=<invalid_or_expired>`  
**Then**
- On `400 INVALID_TOKEN`, an error screen is shown: "The invitation is invalid or has expired. Contact your administrator."
- No form is displayed

#### Scenario 6.4 — Token Already Used

**Given** the user navigates to an already-accepted invitation  
**When** the form is submitted (or on initial load if the API rejects it)  
**Then**
- On `400 INVALID_TOKEN`, error screen: "This invitation has already been used"

---

## Session Management (Cross-Cutting)

### Zustand Store (`store/authStore.ts`)

```ts
interface AuthState {
  user: { name: string; role: 'admin' | 'agent'; email: string; organizationId: string } | null
  isAuthenticated: boolean
  setUser: (user) => void
  clear: () => void
}
```

### Hook `useMe` (TanStack Query)

- Calls `GET /api/me`
- `staleTime: 5 minutes` — avoids refetching on every route change
- On `200`: populates `authStore`
- On `401`: clears `authStore`, does NOT redirect (that's `AuthGuard`'s job)

### Hook `useLogout`

- Calls `POST /api/auth/logout` via `useMutation`
- On success or error: clears `authStore` → redirects to `/login`
- Optimistic: clears local state immediately, API call is fire-and-forget

### Global 401 Interceptor (`services/authService.ts`)

A fetch wrapper (or TanStack Query `onError` default) that intercepts any `401` response from any API call and:
1. Clears `authStore`
2. Redirects to `/login?redirect={currentPath}`

> This handles the case where a session expires mid-navigation. The auth middleware on the backend will attempt a transparent refresh first — the UI only sees a 401 if the refresh also failed.

### Scenario S.1 — Protected Route Without Session

**Given** the user navigates to `/dashboard` without an active session  
**Then**
- `AuthGuard` calls `GET /api/me`
- On `401`, the user is redirected to `/login?redirect=/dashboard`
- After successful login, the user is redirected back to `/dashboard`

### Scenario S.2 — Logout

**Given** the user is authenticated and clicks "Log out"  
**Then**
- `POST /api/auth/logout` is called
- Local state is cleared
- The user is redirected to `/login`
- Both cookies are cleared by the API (`Max-Age=0`)

### Scenario S.3 — Session Expires During Navigation

**Given** the user is authenticated and their `gm_access` has expired  
**When** they make any API request  
**Then**
- The backend middleware transparently refreshes the session (user sees nothing)
- If refresh also fails, the API returns `401`
- The global interceptor catches it and redirects to `/login`

---

## Security Considerations (UI)

- **Never reveal email existence**: Login and forgot-password use generic error messages
- **No token storage in JS**: Cookies are `HttpOnly` — `localStorage`/`sessionStorage` are never used for auth
- **CSRF protection**: Cookies are `SameSite=Lax`, all mutations are `POST`
- **Redirect safety**: The `?redirect=` param should be validated to prevent open redirects (only allow relative paths starting with `/`)
- **Password visibility**: Toggle must default to hidden

---

## Definition of Done

- [ ] All pages are routed and render within `AuthLayout`
- [ ] Forms use `react-hook-form` + Zod with client-side validation before API calls
- [ ] All API calls use TanStack Query (`useMutation` for writes, `useQuery` for reads)
- [ ] `AuthGuard` protects `/dashboard` and future protected routes
- [ ] Global 401 interceptor redirects to `/login`
- [ ] `authStore` (Zustand) is populated on login/verify and cleared on logout/401
- [ ] Error messages do not leak email existence (login, forgot-password)
- [ ] `SuccessScreen` is reused across registration, forgot-password, and reset-password
- [ ] Navigation links connect all auth screens (login ↔ register, login → forgot-password, etc.)
- [ ] All scenarios above have corresponding tests
