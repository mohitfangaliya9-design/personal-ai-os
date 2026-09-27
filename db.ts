/**
 * db.ts
 * -----------------------------------------------------------------------
 * PostgreSQL data-access layer for the Personal AI OS.
 *
 * This file is infrastructure only: connection management, schema setup,
 * and generic query/exec/transaction helpers. It contains no AI, planning,
 * memory, or task-execution logic — callers (memory.ts, orchestrator.ts,
 * etc.) own that.
 *
 * Public API (kept stable for existing callers):
 *   pool: Pool | null
 *   Row
 *   initDb(): Promise<void>
 *   query<T>(text, params?): Promise<T[]>
 *   exec(text, params?): Promise<QueryResult>
 * -----------------------------------------------------------------------
 */

import pg from 'pg';
const { Pool } = pg;

export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------
// Connection
// -----------------------------------------------------------------------
// Configuration comes entirely from environment variables. No credentials
// are ever hard-coded, logged, or otherwise exposed.

const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      // Conservative defaults to avoid unbounded connection growth and to
      // fail fast instead of hanging indefinitely on a bad connection.
      max: Number(process.env.DB_POOL_MAX) || 10,
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30_000,
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10_000,
    })
  : null;

// A pool emits 'error' for problems on idle clients (e.g. the backend
// restarting). Without a listener, Node treats this as an unhandled
// exception and can crash the whole process.
if (pool) {
  pool.on('error', (err) => {
    // Never log the connection string / credentials — only the error.
    console.error('Unexpected PostgreSQL pool error (idle client):', err.message);
  });
}

export function hasDatabase(): boolean {
  return pool !== null;
}

// ---------------------------------------------------------------------
// Minimal in-memory fallback (development convenience only)
// -----------------------------------------------------------------------
// When DATABASE_URL is not set, callers that don't pre-check hasDatabase()
// still get a non-throwing response instead of a crash. This is NOT a
// real database and NOT a second persistence system for production use:
// it stores nothing meaningfully queryable and is only meant to keep
// unconfigured local dev from blowing up on an accidental call.
// Every caller in this codebase should check for a configured database
// before relying on persistence; this fallback exists only as a safety
// net, and it never claims a write succeeded when nothing was persisted.

const memoryFallback = new Map<string, Row[]>();

function fallbackKey(text: string): string {
  return text.trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase();
}

// ---------------------------------------------------------------------
// Schema management
// -----------------------------------------------------------------------
// Uses CREATE TABLE IF NOT EXISTS only — this never drops, truncates, or
// resets existing tables or data.

let schemaInitialized = false;

export async function initDb(): Promise<void> {
  if (!pool) return;
  if (schemaInitialized) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        role TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
        tools JSONB NOT NULL DEFAULT '[]', permissions JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        definition JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL,
        agent_id TEXT, workflow_id TEXT, current_step TEXT, progress INTEGER NOT NULL DEFAULT 0,
        result JSONB, error TEXT, approval_state TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, cron TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id TEXT, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    schemaInitialized = true;
  } catch (error) {
    // Do not swallow this: schema setup failing is a real problem callers
    // need to know about, not something to report as success.
    console.error('initDb failed:', error instanceof Error ? error.message : error);
    throw error;
  }
}

// ---------------------------------------------------------------------
// Query / exec helpers
// -----------------------------------------------------------------------
// Always parameterized ($1, $2, ...) — callers must never interpolate
// untrusted input directly into `text`. These helpers don't validate
// that (SQL text is code, not data), so it remains each caller's
// responsibility, as before.

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  if (pool) {
    try {
      const result = await pool.query(text, params);
      return result.rows as T[];
    } catch (error) {
      console.error('Database query failed:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  // No database configured: honest no-op fallback, never fabricated data.
  const rows = memoryFallback.get(fallbackKey(text)) ?? [];
  return rows as T[];
}

export async function exec(text: string, params: unknown[] = []): Promise<pg.QueryResult<Row>> {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (error) {
      console.error('Database exec failed:', error instanceof Error ? error.message : error);
      throw error;
    }
  }

  // No database configured: return a well-formed, honest empty result
  // rather than pretending a write happened.
  return {
    rows: [],
    rowCount: 0,
    command: '',
    oid: 0,
    fields: [],
  } as unknown as pg.QueryResult<Row>;
}

// ---------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------
// New helper, additive only — existing callers using query()/exec() are
// unaffected. Provided for future multi-step operations (e.g. task +
// audit-log writes that must succeed or fail together).

export interface TransactionClient {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string, params?: unknown[]): Promise<pg.QueryResult<Row>>;
}

/**
 * Runs `fn` inside a single PostgreSQL transaction using one dedicated
 * client from the pool. Commits on success, rolls back on any thrown
 * error, and always releases the client back to the pool.
 *
 * Throws if no database is configured — a transaction cannot be
 * meaningfully faked, so this is not silently downgraded to a no-op.
 */
export async function withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
  if (!pool) {
    throw new Error('withTransaction requires a configured DATABASE_URL; no database connection is available.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txClient: TransactionClient = {
      query: async <T2 extends Row = Row>(text: string, params: unknown[] = []) => {
        const result = await client.query(text, params);
        return result.rows as T2[];
      },
      exec: async (text: string, params: unknown[] = []) => client.query(text, params),
    };

    const result = await fn(txClient);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Transaction rollback failed:', rollbackError instanceof Error ? rollbackError.message : rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------
// Additive helper for graceful process shutdown; does not change any
// existing behavior if callers never invoke it.

export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
}
