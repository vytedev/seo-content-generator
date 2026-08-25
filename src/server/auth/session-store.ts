import type { Pool } from "pg";

export interface OperatorSession {
  tokenHash: string;
  expiresAt: Date;
}

export interface SessionStore {
  create(session: OperatorSession): Promise<void>;
  findActive(tokenHash: string, now: Date): Promise<OperatorSession | undefined>;
  revoke(tokenHash: string, now: Date): Promise<void>;
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(session: OperatorSession): Promise<void> {
    await this.pool.query(
      `insert into operator_sessions (token_hash, expires_at) values ($1, $2)`,
      [session.tokenHash, session.expiresAt],
    );
  }

  async findActive(tokenHash: string, now: Date): Promise<OperatorSession | undefined> {
    const result = await this.pool.query<{
      token_hash: string;
      expires_at: Date;
    }>(
      `select token_hash, expires_at
       from operator_sessions
       where token_hash = $1 and revoked_at is null and expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? { tokenHash: row.token_hash, expiresAt: row.expires_at } : undefined;
  }

  async revoke(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `update operator_sessions set revoked_at = $2
       where token_hash = $1 and revoked_at is null`,
      [tokenHash, now],
    );
  }
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, OperatorSession & { revokedAt?: Date }>();

  async create(session: OperatorSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findActive(tokenHash: string, now: Date): Promise<OperatorSession | undefined> {
    const session = this.sessions.get(tokenHash);
    return session && !session.revokedAt && session.expiresAt > now ? session : undefined;
  }

  async revoke(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = now;
  }
}
