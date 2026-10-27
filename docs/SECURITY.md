# Security guide

How Centinela protects its dashboard and API, how to sign in locally, and how to configure a production instance. The threat analysis behind these choices is in [`THREAT_MODEL.md`](THREAT_MODEL.md); decisions are recorded in [`decisions/S6.md`](decisions/S6.md).

## Signing in locally

Outside production, when `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` are empty or unset, the server uses the development sign-in:

| User name | Password |
| --- | --- |
| `admin` | `centinela-dev` |

The server logs a warning with these credentials when it starts with them, and `npm run demo` prints them at the end.

- `npm run dev`: open <http://localhost:5173>.
- `docker compose up -d --build --wait` (the stack runs with `NODE_ENV=development`): open <http://localhost:8080>.

Over plain HTTP on localhost the session and CSRF cookies are `centinela-local` and `centinela-local-csrf`, without `Secure` (see [Cookies](#cookies)), so every browser, Safari included, can sign in. Opening the dashboard over plain HTTP through another host name or a LAN address does not work: the server keeps the `__Host-` cookies with `Secure` there, the browser drops them, and every sign-in ends on the sign-in page again. Use `localhost`, or put TLS in front.

To use your own password locally, run `npm run hash-password --silent`, paste the printed `ADMIN_PASSWORD_HASH='…'` line into `.env` and restart the server.

## Production configuration

Production (`NODE_ENV=production`) refuses to start, naming the variable and never its value, when:

- `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` or `SESSION_SECRET` is missing;
- `ADMIN_PASSWORD_HASH` is not an argon2id hash, is weaker than argon2id with 19 MiB and 2 iterations (OWASP's minimum), is the development hash, or verifies the development password under another salt (checked at start-up);
- `SESSION_SECRET` is the development value or shorter than 32 characters;
- `INGEST_TOKEN` is the development value or shorter than 32 characters, or `DATABASE_URL` uses the development password (S0).

Steps:

1. `npm run hash-password --silent` (type the password twice; or `printf '%s' "$PASSWORD" | npm run hash-password --silent`). The password is never taken from the command line. It needs at least 12 characters, and the development password is refused. Store the printed line in your secret store; keep the single quotes in `.env` files because the hash contains `$`.
2. `openssl rand -hex 32` for `SESSION_SECRET` and again for `INGEST_TOKEN`.
3. Serve the dashboard and the API over HTTPS from one origin (the bundled nginx proxies `/api`). Set HSTS on the TLS terminator. Production always uses the `__Host-` cookies with `Secure`, so plain HTTP cannot work there.
4. Set `TRUST_PROXY` when a reverse proxy you control sits in front of the API: the number of proxy hops (`1` for the bundled nginx alone) or a comma-separated list of the proxies' addresses or subnets (`10.0.0.5`, `172.16.0.0/12`, `loopback`). Rate limits, the sign-in lockout and the audit log use the client IP Express derives from it. Without it every request seems to come from the proxy, so one lockout locks everyone out. `true` is refused: trusting every hop would let any client set its own IP with `X-Forwarded-For` and walk around the rate limits and the lockout.

Every variable is documented in [`.env.example`](../.env.example) and ARCHITECTURE §15.

## Authentication and sessions

- One admin account. The password is checked with argon2id (`ADMIN_PASSWORD_HASH`); the user name is compared in constant time, and the password is always checked, so a wrong user name takes as long as a wrong password.
- Signing in creates a server-side session in PostgreSQL (`admin_sessions`). The cookie carries a random 256-bit token; the table stores only HMAC-SHA256(`SESSION_SECRET`, token), so a database dump yields no usable cookies. Changing `SESSION_SECRET` signs everyone out.
- A session ends after `SESSION_IDLE_MINUTES` (120) without requests or after `SESSION_MAX_HOURS` (12), whichever comes first. The dashboard checks its session every minute without extending it, and goes to the sign-in page when it has ended.
- Signing in issues a new token and deletes the session the browser held before. Signing out deletes the session, clears both cookies and closes the session's live alert streams; a stream also ends when its session reaches its absolute expiry.
- Cookies: see below.

## Cookies

| Request | Session cookie | CSRF cookie |
| --- | --- | --- |
| Over HTTPS (TLS at the server, or any `X-Forwarded-Proto: https`), and every request with `NODE_ENV=production` | `__Host-centinela`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` | `__Host-centinela-csrf`: readable by the dashboard, otherwise the same attributes |
| Plain HTTP to `localhost`, `127.0.0.0/8` or `::1`, outside production | `centinela-local`: `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Secure` | `centinela-local-csrf`: readable, `SameSite=Strict`, `Path=/`, no `Secure` |
| Plain HTTP to any other host, outside production | the `__Host-` cookies, which browsers drop over plain HTTP | |

The `__Host-` prefix makes browsers require `Secure`, `Path=/` and no `Domain`, so a sibling subdomain cannot set or overwrite the cookies. Chromium and Firefox accept `Secure` cookies from `http://localhost`, but WebKit (Safari) does not, so a development server reached over plain HTTP on localhost uses unprefixed names without `Secure` instead (S8-02 in [decisions/S8.md](decisions/S8.md)). `X-Forwarded-Proto` is believed even without `TRUST_PROXY` for this decision: it can only make the cookies stricter. Each mode reads only its own cookie names, so an unprefixed cookie never authenticates a production or HTTPS request. Signing in clears the other mode's cookies, so the dashboard, which reads whichever CSRF cookie exists, always repeats the current one.

## CSRF protection

Every state-changing request (any method except `GET`, `HEAD` and `OPTIONS`) behind the session must carry the `X-CSRF-Token` header with the value of the CSRF cookie (`__Host-centinela-csrf`, or `centinela-local-csrf` over plain HTTP on localhost). The server accepts it only when header, cookie and HMAC-SHA256(`SESSION_SECRET`, session token) all match, so a token from another session is refused. `SameSite=Strict` already keeps current browsers from sending the cookies on cross-site requests; the token covers older browsers and same-site attackers. The sign-in endpoint only reads JSON bodies, which an HTML form on another site cannot send.

## Which endpoints need what

| Endpoint | Credential |
| --- | --- |
| `GET /api/health` | none |
| `POST /api/auth/login` | none (rate limited, lockout) |
| `POST /api/ingest` | `Authorization: Bearer <token>`: `INGEST_TOKEN` or an active ingest token |
| everything else, including `POST /api/ingest/upload`, `GET /api/stream` and routes added later | dashboard session; plus `X-CSRF-Token` for state-changing requests |

Without a session the API answers `401` (also for unknown paths, so it does not reveal which routes exist); without a valid CSRF token, `403`.

## Brute-force and abuse protection

- `RATE_LIMIT_AUTH_PER_MINUTE` (30) requests per minute per client IP on `/api/auth/*`, `RATE_LIMIT_INGEST_PER_MINUTE` (120) on `/api/ingest`, `RATE_LIMIT_UPLOAD_PER_MINUTE` (30) on `/api/ingest/upload`. Answers past the limit are `429` problem+json with `RateLimit` headers.
- `LOGIN_MAX_FAILURES` (5) failed sign-ins from one client IP within `LOGIN_LOCKOUT_MINUTES` (15) lock that IP out for `LOGIN_LOCKOUT_MINUTES`, even with the right password (`429` with `Retry-After`). Locked clients cost no password work. A successful sign-in clears the count.
- At most 4 password checks run at once (each holds 64 MiB); more answer `503` with `Retry-After: 1`.
- Rate limit and lockout state is kept in memory, per process, and resets on restart.

## Ingest tokens

The Security page creates and revokes bearer tokens for `POST /api/ingest`. A token is `cnt_` followed by 43 random characters; it is shown once, at creation, and only its SHA-256 is stored. The dashboard shows its first 12 characters, when it was last used, and whether it was revoked. At most 50 tokens are active at once. Revoking takes effect immediately. `INGEST_TOKEN` from the environment keeps working next to stored tokens; rotate it by changing the variable and restarting.

## Audit log

The Security page and `GET /api/audit` list, newest first: sign-ins, failed sign-ins (with the attempted user name), lockouts, sign-outs, alert triage (single and bulk), rule enable/disable, token creation and revocation, and dashboard uploads, each with the actor, the target, the client IP and details. Triage and token changes are written in the same transaction as the change, and so are a failed sign-in and the lockout it triggers. Entries are listed in the order they were written (a database sequence), not by timestamp, so rows written in the same millisecond keep their order. The application only inserts audit rows; it cannot protect them from someone with direct write access to the database.

## Security headers

| Where | Headers |
| --- | --- |
| API responses (`/api/*`) | `helmet`: `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, cross-origin policies, HSTS; plus `Cache-Control: no-store` |
| Dashboard HTML and files, nginx (Docker) and `vite preview` | `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy` |
| Vite dev server | the same, plus a per-process nonce for the scripts and styles Vite injects and the HMR WebSocket on `localhost` |

The values are defined once in `packages/web/security/headers.ts`; `packages/web/nginx/security-headers.conf` repeats them for nginx and `packages/web/test/csp.test.ts` fails if the two differ. To check a running instance:

```bash
curl -sI http://localhost:8080/ | grep -i content-security-policy
curl -sI http://localhost:8080/api/health | grep -i content-security-policy
```

## Dependencies

`npm run audit` runs `npm audit --audit-level=high` and fails on high or critical advisories. CI does not run it yet (workflow changes are David's).

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" (security advisories) on the repository rather than in a public issue.
