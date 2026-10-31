# Vercel deployment architecture

## Service topology

The root \`vercel.json\` declares three services:

- \`web\`: public Vite frontend at \`/\`.
- \`gateway\`: public only through \`/api/*\`; provides the single-owner login/session boundary and proxies authenticated API requests.
- \`api\`: internal FastAPI service; no public rewrite points to it.

The only service binding is \`gateway -> api\`, exposed to the gateway at runtime as \`AI_HEDGE_FUND_API_URL\`. Do not manually define that variable. The browser never receives this binding or the backend access token.

The gateway removes the public \`/api\` prefix before forwarding, so the existing FastAPI route paths do not need to change. It forwards SSE response streams and injects the backend-only Bearer token on the server side.

## Required Vercel environment variables

Set these in Vercel project settings. Never commit their values or place them in a \`VITE_*\` variable.

| Variable | Service(s) | Purpose |
| --- | --- | --- |
| \`AI_HEDGE_FUND_OWNER_PASSWORD\` | \`gateway\` | Single-owner login secret; minimum 32 bytes. |
| \`AI_HEDGE_FUND_SESSION_SECRET\` | \`gateway\` | HMAC signing secret for session cookie; minimum 32 bytes. |
| \`AI_HEDGE_FUND_API_TOKEN\` | \`gateway\`, \`api\` | Identical backend-only Bearer token in both services; minimum 32 bytes. |
| \`AI_HEDGE_FUND_API_URL\` | \`gateway\` | Injected automatically by the Vercel service binding. Do not set manually. |

Generate independent secrets locally:

\`\`\`bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
\`\`\`

Run it separately for the owner password, session secret, and backend token. Store the output directly in Vercel Environment Variables. Do not paste secret values into GitHub, chat, build logs, or this file.

Use Preview variables first. Add Production variables only after a reviewed preview passes the security and persistence gates below.

## Authentication properties

- The owner password is checked with a constant-time digest comparison.
- Sessions are HMAC-signed, expire after eight hours, and are held in a \`Secure\`, \`HttpOnly\`, \`SameSite=Strict\`, host-only cookie.
- Login, logout, and state-changing API requests require a same-origin \`Origin\` header.
- The backend token is added only by the gateway. Client-supplied \`Authorization\` and \`Cookie\` headers are not forwarded.
- Missing secrets or a missing/invalid service binding cause the gateway to fail closed.
- API responses are streamed through the gateway; this preserves the existing Server-Sent Events transport.

This is a single shared-secret access gate, not identity-provider SSO, MFA, per-user accounts, or identity verification. Anyone who obtains the owner password can sign in. Rotate the owner password and session secret to invalidate previously issued sessions.

## Local development

The frontend's Vite server proxies \`/api/*\` to \`http://127.0.0.1:8000\` and strips the \`/api\` prefix. The React auth gate is bypassed only when \`import.meta.env.DEV\` is true. The FastAPI backend continues to use its local loopback development path.

For Vercel Services local integration, use the Vercel CLI from the repository root (\`vercel dev -L\`) after installing and configuring the CLI. Service binding availability and routing must be verified using the CLI version supported by the account.

## Release blockers

This configuration is not approval to deploy. Before any Vercel preview using real data, resolve the existing PR #5 blockers:

1. Encrypt API keys at rest and apply a tested, recoverable migration.
2. Replace local SQLite with a managed persistent PostgreSQL database and validate migrations/concurrency.
3. Review the existing Python dependency set against Vercel's supported Python runtime and verify the service build from the root \`pyproject.toml\`.
4. Verify the Vercel internal service binding reaches FastAPI, the gateway's backend token passes the FastAPI middleware, browser authentication works, and streamed hedge-fund responses remain intact.
5. Confirm no unauthenticated public path reaches FastAPI directly.

Adding these files does not create a Vercel project, configure environment variables, deploy code, create a database, or change production resources.
