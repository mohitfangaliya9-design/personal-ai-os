import pg from 'pg';
const { Pool } = pg;

export type Row = Record<string, unknown>;

const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new Pool({ connectionString, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined }) : null;

const memory = new Map<string, Row[]>();

export async function initDb() {
  if (!pool) return;
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
}

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  if (pool) {
    const result = await pool.query(text, params);
    return result.rows as T[];
  }
  // Development fallback: simple in-memory store for the demo. Production should use PostgreSQL.
  const key = text.split(/\s+/).slice(0, 3).join(' ');
  const rows = memory.get(key) ?? [];
  if (/^SELECT/i.test(text)) return rows as T[];
  return rows as T[];
}

export async function exec(text: string, params: unknown[] = []) {
  if (pool) return pool.query(text, params);
  return { rows: [] };
}
