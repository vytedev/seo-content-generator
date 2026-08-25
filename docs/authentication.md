# Single-operator authentication

MM03-01 supports one configured operator account. It has no registration, roles, permissions, invitations, teams, social login or password-reset flow.

## Architecture

- The operator email and encoded scrypt password hash are supplied through the local environment.
- Successful login creates a random opaque session token. Only a keyed SHA-256 hash is stored in PostgreSQL.
- The browser receives the token only in an `HttpOnly`, host-only, `SameSite=Strict` cookie.
- Sessions expire after `SESSION_TTL_HOURS`; logout appends a revocation time instead of deleting history.
- Unsafe authenticated API requests require both an approved local Origin and the in-memory CSRF token returned by the session endpoint.
- `/api/health`, login/session bootstrap and the state-bound Google OAuth callback are the only authentication exceptions. All editorial APIs are protected.

## Local configuration

Copy the variable names from `.env.example` into the untracked local `.env`:

- `OPERATOR_EMAIL`
- `OPERATOR_PASSWORD_HASH`
- `SESSION_SECRET`
- `SESSION_TTL_HOURS`

The recommended local setup is an interactive wizard:

```bash
npm run auth:setup
```

It asks for the operator email and password, confirms the password, generates the encoded scrypt hash and an independent random session secret, then writes only those derived values to the already-gitignored local `.env`. Password entry is hidden and is never passed through command arguments or shell history.

For manual or automated configuration, `npm run auth:hash-password` reads a password from a hidden terminal prompt (or standard input) and prints only the encoded hash. Never reuse the Google token-encryption key as the session secret.

When PostgreSQL is configured, missing or partial operator authentication configuration stops application startup safely.

## Operator flow

1. The client checks `GET /api/auth/session` before rendering private content.
2. An unauthenticated operator sees only the Mobelaris sign-in screen.
3. Successful login opens the Blog post workspace.
4. Session expiry returns the operator to sign-in; committed pipeline state remains in PostgreSQL.
5. Sign out revokes the current session, clears the cookie and removes private content from the page.

## Local verification

Use fake credentials and a disposable PostgreSQL database only:

```bash
npm run format
npm run check
npm run db:generate
npm run format:check
```

After applying migrations to disposable PostgreSQL, run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db-invariants.sql
```
