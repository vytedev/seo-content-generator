import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export const GOOGLE_DOCS_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
] as const;
export const GOOGLE_GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"] as const;
export const GOOGLE_SCOPES = [...GOOGLE_DOCS_SCOPES, ...GOOGLE_GSC_SCOPES] as const;
export type GoogleConsentPurpose = "docs" | "gsc";
export function scopesForConsent(purpose: GoogleConsentPurpose): readonly string[] {
  // The optional upgrade includes the already-required scopes so one encrypted
  // connection remains sufficient and a GSC-only token can never replace Docs access.
  return purpose === "gsc" ? GOOGLE_SCOPES : GOOGLE_DOCS_SCOPES;
}
const GOOGLE_LOCK = "google_oauth:google";
const APPROVED_HTTPS_REDIRECT_URIS = new Set([
  "https://content-generator.vyte.dev/api/integrations/google/callback",
]);

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
}

export interface StoredGoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

export function googleOAuthConfigFromEnv(env: NodeJS.ProcessEnv): GoogleOAuthConfig | undefined {
  const names = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
  ] as const;
  const values = names.map((name) => env[name]?.trim() ?? "");
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value)) {
    throw new GoogleOAuthError("Google OAuth configuration is incomplete.");
  }
  const [clientId, clientSecret, redirectUri, encodedKey] = values as [
    string,
    string,
    string,
    string,
  ];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
    throw new GoogleOAuthError("Google OAuth configuration is invalid.");
  }
  const encryptionKey = Buffer.from(encodedKey, "base64");
  if (encryptionKey.length !== 32) {
    throw new GoogleOAuthError("Google OAuth configuration is invalid.");
  }
  try {
    const redirect = new URL(redirectUri);
    const isLocalHttp =
      redirect.protocol === "http:" &&
      new Set(["localhost", "127.0.0.1", "::1"]).has(redirect.hostname);
    const isApprovedHttps = APPROVED_HTTPS_REDIRECT_URIS.has(redirect.toString());
    if (!isLocalHttp && !isApprovedHttps) throw new Error("redirect not approved");
    return { clientId, clientSecret, redirectUri: redirect.toString(), encryptionKey };
  } catch {
    throw new GoogleOAuthError("Google OAuth redirect URI is not approved.");
  }
}

export class GoogleOAuthError extends Error {
  constructor(message = "Google connection could not be completed.") {
    super(message);
  }
}

interface StoredVersion extends StoredGoogleTokens {
  version: number;
}

class UnreadableGoogleConnectionError extends GoogleOAuthError {}

export type GoogleDisconnectOutcome = "disconnected" | "already_disconnected" | "local_only";

export class GoogleTokenStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  async status(): Promise<{ connected: boolean; connectedAt: string | null }> {
    const result = await this.pool.query<{ event: string; created_at: Date }>(
      `select event,created_at from google_oauth_token_versions
       where provider='google' order by version desc limit 1`,
    );
    const latest = result.rows[0];
    return {
      connected: latest?.event === "connected",
      connectedAt: latest?.event === "connected" ? latest.created_at.toISOString() : null,
    };
  }

  async load(): Promise<StoredGoogleTokens | null> {
    return this.withLock(async (client) => this.loadFrom(client));
  }

  async save(tokens: StoredGoogleTokens): Promise<void> {
    await this.withLock(async (client) => this.insertConnected(client, tokens));
  }

  async serialised<T>(
    operation: (current: StoredVersion | null, client: PoolClient) => Promise<T>,
  ) {
    return this.withLock(async (client) => operation(await this.loadFrom(client), client));
  }

  async disconnectSerialised(
    operation: (current: StoredVersion, client: PoolClient) => Promise<void>,
  ): Promise<GoogleDisconnectOutcome> {
    return this.withLock(async (client) => {
      let current: StoredVersion | null;
      try {
        current = await this.loadFrom(client);
      } catch (error) {
        if (!(error instanceof UnreadableGoogleConnectionError)) throw error;
        // Revocation is impossible without readable token material. Preserve the append-only
        // history and clear only the unusable local connection while still holding the lock.
        await this.tombstoneSerialised(client);
        return "local_only";
      }
      if (!current) return "already_disconnected";
      await operation(current, client);
      return "disconnected";
    });
  }

  async saveSerialised(client: PoolClient, tokens: StoredGoogleTokens): Promise<void> {
    await this.insertConnected(client, tokens);
  }

  async tombstoneSerialised(client: PoolClient): Promise<void> {
    await client.query(
      `insert into google_oauth_token_versions(provider,event) values('google','disconnected')`,
    );
  }

  private async withLock<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1,0))", [GOOGLE_LOCK]);
      return await operation(client);
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [GOOGLE_LOCK]);
      client.release();
    }
  }

  private async loadFrom(client: PoolClient): Promise<StoredVersion | null> {
    const result = await client.query<{
      version: string | number;
      event: string;
      encrypted_tokens: string | null;
      iv: string | null;
      auth_tag: string | null;
    }>(
      `select version,event,encrypted_tokens,iv,auth_tag from google_oauth_token_versions
       where provider='google' order by version desc limit 1`,
    );
    const latest = result.rows[0];
    if (
      !latest ||
      latest.event !== "connected" ||
      !latest.encrypted_tokens ||
      !latest.iv ||
      !latest.auth_tag
    )
      return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(latest.iv, "base64"));
      decipher.setAuthTag(Buffer.from(latest.auth_tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(latest.encrypted_tokens, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = storedTokensSchema.parse(JSON.parse(plaintext));
      return {
        version: Number(latest.version),
        accessToken: parsed.accessToken,
        ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
        expiresAt: parsed.expiresAt,
        scope: parsed.scope,
      };
    } catch {
      throw new UnreadableGoogleConnectionError(
        "The stored Google connection could not be read safely.",
      );
    }
  }

  private async insertConnected(client: PoolClient, tokens: StoredGoogleTokens): Promise<void> {
    assertRequiredScopes(tokens.scope, GOOGLE_DOCS_SCOPES);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);
    await client.query(
      `insert into google_oauth_token_versions(provider,event,encrypted_tokens,iv,auth_tag,expires_at,scope)
       values('google','connected',$1,$2,$3,$4,$5)`,
      [
        encrypted.toString("base64"),
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        tokens.expiresAt,
        tokens.scope,
      ],
    );
  }
}

const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.coerce.date(),
  scope: z.string(),
});

export class GoogleOAuthClient {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly store: GoogleTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorisationUrl(
    state: string,
    codeChallenge: string,
    purpose: GoogleConsentPurpose = "docs",
  ): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: scopesForConsent(purpose).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchangeCode(
    code: string,
    verifier: string,
    purpose: GoogleConsentPurpose = "docs",
  ): Promise<void> {
    await this.store.serialised(async (_current, client) => {
      const tokens = await this.tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: this.config.redirectUri,
      });
      if (!tokens.refresh_token) throw new GoogleOAuthError();
      assertRequiredScopes(tokens.scope ?? "", scopesForConsent(purpose));
      await this.store.saveSerialised(client, toStoredTokens(tokens));
    });
  }

  async accessToken(requiredScopes: readonly string[] = GOOGLE_DOCS_SCOPES): Promise<string> {
    return this.store.serialised(async (stored, client) => {
      if (!stored) throw new GoogleOAuthError("Google is not connected.");
      assertRequiredScopes(stored.scope, requiredScopes);
      if (stored.expiresAt.getTime() > Date.now() + 60_000) return stored.accessToken;
      if (!stored.refreshToken) throw new GoogleOAuthError("The Google connection has expired.");
      const refreshed = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      });
      const scope = refreshed.scope ?? stored.scope;
      assertRequiredScopes(scope, requiredScopes);
      await this.store.saveSerialised(client, {
        ...toStoredTokens(refreshed),
        refreshToken: refreshed.refresh_token ?? stored.refreshToken,
        scope,
      });
      return refreshed.access_token;
    });
  }

  async disconnect(): Promise<GoogleDisconnectOutcome> {
    return this.store.disconnectSerialised(async (stored, client) => {
      const token = stored.refreshToken ?? stored.accessToken;
      let response: Response;
      try {
        response = await retryingBoundedFetch(
          this.fetchImpl,
          "https://oauth2.googleapis.com/revoke",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token }),
          },
          10_000,
        );
      } catch {
        throw new GoogleOAuthError(
          "Google could not be revoked; the local connection was retained.",
        );
      }
      // Google returns 400 for an already-invalid token. It is safe to tombstone locally.
      if (!response.ok && response.status !== 400) {
        throw new GoogleOAuthError(
          "Google could not be revoked; the local connection was retained.",
        );
      }
      await this.store.tombstoneSerialised(client);
    });
  }

  private async tokenRequest(parameters: Record<string, string>) {
    let response: Response;
    try {
      response = await retryingBoundedFetch(
        this.fetchImpl,
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            ...parameters,
          }),
        },
        10_000,
      );
    } catch {
      throw new GoogleOAuthError();
    }
    if (!response.ok) throw new GoogleOAuthError();
    try {
      return tokenResponseSchema.parse(await response.json());
    } catch {
      throw new GoogleOAuthError();
    }
  }
}

export function assertRequiredScopes(
  scope: string,
  requiredScopes: readonly string[] = GOOGLE_SCOPES,
): void {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  if (!requiredScopes.every((required) => granted.has(required)))
    throw new GoogleOAuthError("Google did not grant the access required for this operation.");
}

function toStoredTokens(tokens: z.infer<typeof tokenResponseSchema>): StoredGoogleTokens {
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scope: tokens.scope ?? "",
  };
}

export async function boundedFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** At most one retry, only for operations whose replay is safe. */
export async function retryingBoundedFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await boundedFetch(fetchImpl, input, init, timeoutMs);
      if (attempt === 1 || (response.status !== 429 && response.status < 500)) return response;
      await retryDelay(response.headers.get("retry-after"));
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function retryDelay(retryAfter: string | null): Promise<void> {
  if (!retryAfter) return;
  const seconds = Number(retryAfter);
  const dateDelay = Date.parse(retryAfter) - Date.now();
  const delay = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 2_000)));
  }
}
