# Local handover setup

This guide starts MM03-01 on another operator's computer. It does not contain credentials. The real `.env` is local and gitignored; only `.env.example` belongs in Git.

## What the operator needs

- Node.js compatible with the checked-in dependencies
- PostgreSQL with an empty local database
- An OpenRouter API key and pinned model ID
- A Google Cloud OAuth client authorised for the local callback
- Their own operator email and password

Do not share an existing `.env`, password hash, session secret, Google token-encryption key or connected Gmail session. In particular, Sir JN should create his own operator login and connect the intended Google account in the app. Aaron's actual password must never be added to `.env.example`, documentation, Git or ordinary chat.

## 1. Install the application

From the repository root:

```bash
npm ci
cp .env.example .env
```

Keep `.env` local. It is ignored by Git.

## 2. Configure local PostgreSQL

Create an empty local PostgreSQL database and set its URL in `.env`:

```dotenv
DATABASE_URL=postgresql://LOCAL_USER:LOCAL_PASSWORD@127.0.0.1:5432/mm0301
```

Apply every SQL file under `drizzle/` in filename order. Example when `psql` is available:

```bash
for migration in drizzle/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

Then load the local reference slots and approved local baseline:

```bash
npm run db:seed:references
npm run db:import:local-baseline
```

These scripts load the gitignored local `.env` without printing its values.

## 3. Create the operator login

Run:

```bash
npm run auth:setup
```

Enter the operator's own email and a new password of at least 12 characters. The command:

- hides password entry;
- writes the email and derived password hash to the gitignored `.env`;
- generates a separate random session secret;
- never stores the plain password.

Restart the app after changing authentication. Do not give Sir JN Aaron's existing password. If Aaron is the intended operator on that installation, Aaron should enter or privately provide a new installation-specific password through an approved secure channel.

## 4. Configure the model provider

Set one provider only. For OpenRouter:

```dotenv
OPENROUTER_API_KEY=replace-with-the-private-key
OPENROUTER_MODEL=replace-with-an-explicit-pinned-model-id
```

Do not use a `latest` model alias. Keep `LOCAL_ALLOW_UNVERIFIED_LINK_BYPASS=false` for normal runs.

## 5. Configure Google OAuth

Use an organisation- or operator-owned Google Cloud project. Do not reuse another developer's connected Gmail session.

In Google Cloud:

1. Enable the Google Docs API.
2. Enable the Google Drive API.
3. Enable the Search Console API if optional GSC enrichment will be used.
4. Configure the OAuth consent screen.
5. While the OAuth app is in testing mode, add the intended Google account as a test user.
6. Create a Web application OAuth client.
7. Register this authorised redirect URI exactly:

```text
http://127.0.0.1:3100/api/integrations/google/callback
```

Add the client values to the local `.env`:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=replace-with-client-id
GOOGLE_OAUTH_CLIENT_SECRET=replace-with-client-secret
GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:3100/api/integrations/google/callback
```

Generate a new token-encryption key for this installation:

```bash
openssl rand -base64 32
```

Store the result only in local `.env`:

```dotenv
GOOGLE_TOKEN_ENCRYPTION_KEY=replace-with-generated-value
```

This key encrypts stored Google tokens. Changing it later requires reconnecting Google.

After the app starts, use its Google connection control and sign in with the account that should own the exported Docs. The OAuth client identifies the application; the account selected during in-app consent owns the connection. Copying another machine's OAuth client values alone does not copy its connected account, but each installation should still use approved ownership and secret-sharing practices.

## 6. Review source configuration

The checked-in example configures the Mobelaris English sitemap and public storefront:

```dotenv
INTERNAL_LINK_SITEMAP_URL=https://www.mobelaris.com/en/sitemap.xml
INTERNAL_LINK_SITE_ORIGIN=https://www.mobelaris.com
INTERNAL_LINK_ALLOWED_ORIGINS=https://www.mobelaris.com,https://searchconsole.googleapis.com
FACT_VERIFIER_ALLOWED_ORIGINS=https://www.mobelaris.com
```

To enable optional Search Console enrichment, set the exact property available to the connected Google account:

```dotenv
GSC_SITE_URL=https://www.mobelaris.com/
```

Omit `GSC_SITE_URL` to use sitemap-only link discovery.

## 7. Start the app

Development mode:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The API runs at `http://127.0.0.1:3100`. Sign in with the operator credentials created by `npm run auth:setup`.

For a local built run:

```bash
npm run build
npm start
```

Then use the API-served local origin shown by the startup output.

## 8. Verify before real use

Run:

```bash
npm run format
npm run check
npm run db:generate
npm run format:check
git diff --check
```

Before spending model credit or exporting a real document, verify:

- operator sign-in works;
- the sitemap source is healthy;
- the pinned model is configured;
- Google is connected to the intended account;
- Docs and Drive APIs are enabled;
- one controlled test run completes without duplicate documents.

## Secure handover

Commit and push `.env.example` and this guide. Never commit `.env`.

Send only the required secret values through an approved private secret-sharing channel. Prefer a password manager or expiring secret link over ordinary Google Chat. If ordinary chat is the only approved channel, send values only in a direct conversation, never a group, and rotate/delete them after transfer where possible. Never send Aaron's plain password; create a new operator password on the target installation.
