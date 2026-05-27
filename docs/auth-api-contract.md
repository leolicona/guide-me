# Agnostic Auth — API Contract & Integration Guide

This document defines the API specifications, details the endpoints (contract), and explains how to perform worker-to-worker (W2W) requests for **Agnostic Auth**, a lightweight, serverless passwordless Identity Provider (IdP) based on Magic Links.

---

## 1. API Description (Overview)

Agnostic Auth is a stateless, passwordless authentication provider designed to run on Cloudflare Workers. It uses Cloudflare KV for temporary state and session storage, meaning it requires no traditional SQL/NoSQL database.

### General Conventions
- **Protocol:** HTTPS (in production) or HTTP (in local development).
- **Format:** All API payloads and responses are in JSON format (`application/json`).
- **CORS:** Cross-Origin Resource Sharing is enabled for all origins, allowing direct calls from frontends or backend-for-frontends (BFF).
- **JWT Alg:** Tokens are signed using **HS256** using either a global or per-application `jwtSecret`.

### Standard Success Response
Every successful API request returns a `200 OK` status code with the following envelope:
```json
{
  "success": true,
  "data": {
    // Endpoint-specific response payload
  }
}
```

### Standard Error Response
When an error occurs, the API returns a structured error object along with the appropriate HTTP status code:
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error description",
  "timestamp": "2026-05-26T18:40:00.000Z",
  "requestId": "9e17e90e0dcd6725",
  "details": {} // Optional, present in VALIDATION_ERROR with validation fields
}
```

#### Supported Error Codes:
- `HTTP_EXCEPTION` (400/404): Business logic exceptions (e.g. token expired, application not registered).
- `VALIDATION_ERROR` (400): Request payload validation failed (e.g. missing required fields).
- `AUTHENTICATION_ERROR` (401): Expired, revoked, or signature-failed JWTs or Refresh Tokens.
- `RATE_LIMIT_EXCEEDED` (429): Rate limits breached.
- `INTERNAL_SERVER_ERROR` (500): Unexpected system failures.

### JWT Claims Architecture
The issued JWTs align with standard OpenID Connect (OIDC) specifications:
- `sub` (Subject): The verified user identity (phone number or email).
- `iss` (Issuer): Set to `auth-service-agnostic`.
- `aud` (Audience): The `appId` of the consumer client application.
- `iat` (Issued At): Unix epoch timestamp (seconds) when the token was generated.
- `exp` (Expiration): Unix epoch timestamp (seconds) when the token expires (default is 15 minutes, configurable per app).

---

## 2. API Endpoints Contract

### GET /
Retrieves the service metadata, version, and the list of active endpoints.

- **Request Headers:** None
- **Request Body:** None
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Agnostic Auth — Identity Provider",
    "version": "2.0.0",
    "endpoints": {
      "initiate": "POST /auth/initiate",
      "verify": "POST /auth/verify",
      "refresh": "POST /auth/refresh",
      "revoke": "POST /auth/token/revoke",
      "health": "GET /auth/health"
    },
    "timestamp": "2026-05-26T18:41:00.000Z"
  }
  ```

---

### GET /health
Lightweight health check endpoint for monitoring purposes.

- **Request Headers:** None
- **Request Body:** None
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "status": "healthy",
    "timestamp": "2026-05-26T18:41:00.000Z"
  }
  ```

---

### POST /auth/initiate
Generates an ephemeral, single-use verification token and builds a Magic Link. The calling application receives the token and the link to send to the user (via email, SMS, etc.).

- **Request Schema (Zod):**
  ```json
  {
    "appId": "string (min: 1)",
    "identity": "string (min: 1)"
  }
  ```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `appId` | `string` | **Yes** | The registered ID of the client application. |
| `identity` | `string` | **Yes** | User identity (e.g. email address or phone number). |

- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "data": {
      "token": "4a7b9c2d-8e1f-432b-a567-cde890f12a34",
      "magicLink": "https://your-app-domain.com/verify?token=4a7b9c2d-8e1f-432b-a567-cde890f12a34"
    }
  }
  ```
  > [!IMPORTANT]
  > The `token` is **single-use** and valid for exactly **10 minutes**.

---

### POST /auth/verify
Consumes the verification token and exchanges it for a new access token (`jwt`) and a long-lived session `refreshToken`.

- **Request Schema (Zod):**
  ```json
  {
    "appId": "string (min: 1)",
    "token": "string (min: 1)"
  }
  ```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `appId` | `string` | **Yes** | Must match the `appId` used during `/auth/initiate`. |
| `token` | `string` | **Yes** | The verification token extracted from the Magic Link query parameters. |

- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "data": {
      "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3VhcmlvQGNvcnJlby5jb20iLCJpc3MiOiJhdXRoLXNlcnZpY2UtYWdub3N0aWMiLCJhdWQiOiJtaS1hcGxpY2FjaW9uIiwiaWF0IjoxNzg1MTE2NDAwLCJleHAiOjE3ODUxMTczMDB9...",
      "refreshToken": "rt_8f9g0h1i_2j3k4l5m_6n7o8p9q"
    }
  }
  ```
  > [!WARNING]
  > Replaying a consumed token returns a `400 Bad Request` with an "Invalid or expired verification token" message.

- **Background Callback Webhook (Optional):**
  If `callbackUrl` is configured in the App Registry config, a non-blocking `POST` request is dispatched asynchronously to that URL:
  ```json
  {
    "identity": "user-identity",
    "appId": "appId",
    "jwt": "eyJhbG...",
    "verifiedAt": "ISO-TIMESTAMP"
  }
  ```

---

### POST /auth/refresh
Refreshes the user's session. It implements **Refresh Token Rotation (RTR)**, meaning every call invalidates the presented `refreshToken` and issues a brand-new one to prevent token-replay attacks.

- **Request Schema (Zod):**
  ```json
  {
    "appId": "string (min: 1)",
    "refreshToken": "string (min: 1)"
  }
  ```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `appId` | `string` | **Yes** | The ID of the client application. |
| `refreshToken` | `string` | **Yes** | The active session's refresh token. |

- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "data": {
      "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi...",
      "refreshToken": "rt_9a8b7c6d_5e4f3g2h_1i0j9k8l"
    }
  }
  ```

---

### POST /auth/token/revoke
Logs the user out by permanently deleting the refresh token from KV, preventing further token refreshes.

- **Request Schema (Zod):**
  ```json
  {
    "appId": "string (min: 1)",
    "refreshToken": "string (min: 1)"
  }
  ```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `appId` | `string` | **Yes** | The ID of the client application. |
| `refreshToken` | `string` | **Yes** | The refresh token to be revoked. |

- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Token revoked successfully"
  }
  ```

---

## 3. Worker-to-Worker (W2W) Requests

When calling `agnostic-auth` from another Cloudflare Worker, you can communicate either via standard external HTTP calls or via internal **Service Bindings** (highly recommended if they are on the same Cloudflare account).

### Approach A: Service Bindings (Recommended)
Service bindings enable zero-latency, secure, and cost-free communication directly between Workers without leaving the Cloudflare network.

#### 1. Add Service Binding in Caller's `wrangler.jsonc`
Under the `services` array, configure a binding pointing to the target service name (`agnostic-auth`) using the specific binding name `AGNOSTIC_AUTH_API`:
```json
{
  "services": [
    {
      "binding": "AGNOSTIC_AUTH_API",
      "service": "agnostic-auth"
    }
  ]
}
```

#### 2. Declare types in Caller Worker's codebase
Declare the binding type as `Fetcher` inside your environment interface:
```typescript
interface Env {
  AGNOSTIC_AUTH_API: Fetcher;
}
```

#### 3. Fetching the API internally
Invoke the fetcher on the binding. Note that the origin (domain) inside the fetch call is ignored because requests route directly to the target worker. Using a dummy origin like `http://auth.local` is recommended:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Example: Triggering authentication initiation
    const authResponse = await env.AGNOSTIC_AUTH_API.fetch("http://auth.local/auth/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        appId: "my-app-id",
        identity: "user@example.com"
      })
    });

    const result = await authResponse.json();
    return Response.json(result);
  }
}
```

---

### Approach B: Standard HTTP Fetch (Cross-Account / External)
If the caller Worker belongs to a different Cloudflare account or service bindings cannot be used, communicate using the public endpoint:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const authResponse = await fetch("https://agnostic-auth.leolicona-dev.workers.dev/auth/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        appId: "my-app-id",
        identity: "user@example.com"
      })
    });

    const result = await authResponse.json();
    return Response.json(result);
  }
}
```
