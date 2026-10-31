# Vercel deployment architecture

## Service topology

The root `vercel.json` declares three services:

- `web`: public Vite frontend at `/`.
- `gateway`: public only through `/api` and `/api/*`; it provides the single-owner login/session boundary and proxies authenticated API requests.
- `api`: internal FastAPI service. No public rewrite targets it.

The only binding is `gateway -> api`, exposed to the gateway at runtime as `AI_HEDGE_FUND_API_URL`. Do not define that variable manually. The browser never receives the binding URL.

Vercel Service Bindings route service-to-service traffic over Vercel's internal network and provide internal authentication and TLS. The API remains private because no top-level public rewrite targets the `api` service. The gateway strips the public `/api` prefix before forwarding, preserving the FastAPI route paths already used by the application. It streams API responses, including the existing Server-Sent Events endpoints.

## Environment variables

Configure Preview values first. Do not add secrets to Git or to any `VITE_*` variable.

| Variable | Secret? | Purpose |
| --- | --- | --- |
| `AI_HEDGE_FUND_OWNER_PASSWORD` | Yes | Single-owner login password; minimum 32 bytes. |
| `AI_HEDGE_FUND_SESSION_SECRET` | Yes | HMAC signing key for the session cookie; minimum 32 bytes. |
| `AI_HEDGE_FUND_API_PRIVATE_SERVICE` | No | Set to `true` for Preview and Production. FastAPI fails closed if a Vercel Preview/Production deployment does not explicitly mark the API service private. |
| `AI_HEDGE_FUND_API_URL` | Injected | Automatically supplied to the gateway by the service binding. Do not set it manually. |
| `VERCEL_ENV` | System | Vercel-provided deployment environment, used with the private-service flag. |

The Vercel binding handles service-to-service authentication and TLS. The gateway does not need a shared API Bearer token for this Vercel deployment. The existing `AI_HEDGE_FUND_API_TOKEN` boundary remains available for non-Vercel remote deployments.

Generate independent random values for the owner password and session secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Run this command separately for each value. Store the results directly in the hosting platform's secret configuration. Do not paste them into GitHub, source files, logs, or chat.

## Build-time secret exposure — deployment blocker

Vercel project environment variables are available during both the Build Step and Function execution, and Vercel Services share project environment configuration. This matters because the owner password and session-signing key must only be available to the gateway at runtime.

The Vite service install/build commands in `vercel.json` explicitly remove these two variables from the `npm ci` and `npm run build` processes. The Python API service's dependency installation/build has not yet been wrapped in an equivalent verified secret-free command. Do not configure the owner/session secrets in Vercel until that Python build exposure is resolved, for example by validating a locked Python install command that strips the variables, or by moving runtime secrets to a runtime-only secret provider.

The gateway service has no third-party npm dependencies. Still verify the actual Vercel build logs and environment behavior before enabling credentials.

## Authentication properties

- The owner password is compared using a constant-time digest comparison.
- Sessions are HMAC-SHA256 signed, expire after eight hours, and use a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie.
- Login, logout, and state-changing API requests require a same-origin HTTPS `Origin` matching the request host.
- Client-supplied `Authorization` and `Cookie` headers are not forwarded to FastAPI.
- Missing required gateway secrets or a missing/invalid service-binding URL cause the gateway to fail closed.
- FastAPI accepts remote traffic in Vercel Preview/Production only when `AI_HEDGE_FUND_API_PRIVATE_SERVICE=true`; otherwise its existing remote Bearer-token boundary remains active.
- The gateway currently has no durable login rate limiter. Configure a Vercel Firewall rate limit for `POST /api/auth/login` before exposing the preview to untrusted traffic.

This is a single shared-password access gate, not identity-provider SSO, MFA, per-user accounts, or identity verification. Anyone who obtains the owner password can sign in. Rotating the owner password and session key invalidates new checks against previously issued sessions.

## Local development

Frontend API clients use same-origin `/api` paths. Vite proxies these requests to `http://127.0.0.1:8000` and strips the `/api` prefix. The React auth gate is bypassed only when `import.meta.env.DEV` is true. The FastAPI backend continues to allow local loopback requests.

Use `vercel dev -L` from the repository root for local Vercel Services integration. Verify the service binding and path routing using the Vercel CLI version supported by the account.

## Release blockers

This code change is not approval to deploy. Before creating a Vercel preview with real secrets or data:

1. Encrypt API keys at rest and apply a tested, recoverable migration.
2. Replace local SQLite with managed persistent PostgreSQL and validate migrations/concurrency.
3. Generate and validate a reproducible Vercel Python dependency lock/install workflow. The repository currently uses Poetry metadata and a Poetry lockfile; Vercel's native Python builder uses uv.
4. Remove owner/session secrets from the Python API build environment, or use a verified runtime-only secret provider.
5. Configure rate limiting for the login endpoint.
6. Verify the internal service binding, private API routing, cookie behavior, gateway-to-FastAPI requests, and streamed hedge-fund responses in a Vercel Preview.
7. Confirm no unauthenticated public path reaches FastAPI directly.

These changes do not create a Vercel project, configure environment variables, deploy code, create a database, or change production resources.
