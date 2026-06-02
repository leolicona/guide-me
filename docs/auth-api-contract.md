# Agnostic Auth — Integration Guide

Stateless Identity Provider on Cloudflare Workers.

## API Basics

- **Format:** JSON (`application/json`)
- **JWT:** HS256
- **Response Envelope:**
  ```json
  {
    "success": true,
    "data": { /* endpoint-specific */ }
  }
  ```

**Error Codes:** `HTTP_EXCEPTION` (400/404), `VALIDATION_ERROR` (400), `AUTHENTICATION_ERROR` (401), `RATE_LIMIT_EXCEEDED` (429), `INTERNAL_SERVER_ERROR` (500)

---

## Endpoints

### POST /auth/initiate
```json
{ "appId": "string", "identity": "string" }
```
**Response:**
```json
{
  "success": true,
  "data": {
    "token": "uuid",
    "magicLink": "https://your-app-domain.com/verify?token=uuid"
  }
}
```

### POST /auth/verify
```json
{ "appId": "string", "token": "string" }
```
**Response:**
```json
{
  "success": true,
  "data": {
    "jwt": "token",
    "refreshToken": "token"
  }
}
```

### POST /auth/refresh
```json
{ "appId": "string", "refreshToken": "string" }
```
**Response:**
```json
{
  "success": true,
  "data": {
    "jwt": "token",
    "refreshToken": "token"
  }
}
```

### POST /auth/token/revoke
```json
{ "appId": "string", "refreshToken": "string" }
```

### POST /auth/hash
```json
{ "password": "string" }
```
**Response:**
```json
{
  "success": true,
  "data": {
    "hash": "string",
    "salt": "string"
  }
}
```

### POST /auth/verify-password
```json
{ "password": "string", "hash": "string", "salt": "string" }
```
**Response:**
```json
{
  "success": true,
  "data": {
    "jwt": "token",
    "refreshToken": "token"
  }
}
```

### GET /health
**Response:**
```json
{ "success": true, "status": "healthy" }
```

### GET /
**Response:**
```json
{
  "success": true,
  "version": "2.0.0",
  "endpoints": { /* list of endpoints */ }
}
```

---

## Integration

### Service Bindings (Recommended)

**wrangler.jsonc:**
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

**TypeScript:**
```typescript
interface Env {
  AGNOSTIC_AUTH_API: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await env.AGNOSTIC_AUTH_API.fetch("http://auth.local/auth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "my-app-id",
        identity: "user@example.com"
      })
    });
    return res;
  }
}
```

### HTTP Fetch (External)

```typescript
const res = await fetch("https://agnostic-auth.leolicona-dev.workers.dev/auth/initiate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    appId: "my-app-id",
    identity: "user@example.com"
  })
});
```
