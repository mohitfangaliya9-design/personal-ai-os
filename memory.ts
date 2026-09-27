/**
 * memory.ts
 * -----------------------------------------------------------------------
 * Memory layer for the Personal AI OS.
 *
 * Responsibilities:
 *  - Store and retrieve structured memories, backed by the existing
 *    PostgreSQL layer (db.ts). No second/parallel storage system.
 *  - Stay strictly separate from planning/execution: this file never
 *    calls planner.ts or orchestrator.ts, and never executes actions.
 *  - Avoid persisting sensitive secrets (API keys, passwords, tokens).
 *  - Avoid pointless duplicate memories.
 *  - Be honest: a DB failure is reported as a failure, never disguised
 *    as a successful save.
 *  - Stay ready for future AI context retrieval (relevance, source,
 *    metadata, kind-based filtering) without over-engineering today.
 *
 * Public API (kept stable for existing callers):
 *   saveMemory(text: string, kind?: string, options?: SaveMemoryOptions): Promise<SaveMemoryResult>
 *   searchMemory(term: string, options?: SearchMemoryOptions): Promise<MemoryRecord[]>
 * -----------------------------------------------------------------------
 */

import { exec, query } from './db.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface MemoryRecord {
  id: string;
  kind: string;
  text: string;
  source: string | null;
  relevance: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SaveMemoryOptions {
  /** Where this memory came from, e.g. "user", "agent:research", "system". */
  source?: string;
  /** Optional relevance/importance score. Defaults to 1.0. */
  relevance?: number;
  /** Arbitrary structured metadata (must be JSON-serializable). */
  metadata?: Record<string, unknown>;
}

export interface SaveMemoryResult {
  id: string;
  text: string;
  kind: string;
  persisted: boolean;
  /** True if an existing, effectively-identical memory was reused instead of inserting a duplicate. */
  deduped: boolean;
  /** True if the memory was refused because it looked like a secret/credential. */
  blocked: boolean;
  reason?: string;
}

export interface SearchMemoryOptions {
  kind?: string;
  limit?: number;
}

// ---------------------------------------------------------------------
// Config / helpers
// ---------------------------------------------------------------------

function hasPg(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------
// Secret detection
// -----------------------------------------------------------------------
// Best-effort guard, not a security boundary: memories are not meant to
// hold credentials, so we refuse anything that looks like one rather
// than silently storing it.

const SECRET_PATTERNS: RegExp[] = [
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /\bsk-[A-Za-z0-9]{16,}/, // OpenAI-style secret keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------
// Schema management
// -----------------------------------------------------------------------
// Ensured once per process (not on every call) to avoid redundant DDL
// round-trips, and re-attempted if it ever fails.

let schemaEnsured = false;

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;

  await exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT,
      relevance DOUBLE PRECISION NOT NULL DEFAULT 1,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Additive, backward-compatible upgrades for tables created by the
  // older version of this file (id, kind, text, created_at only).
  await exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS source TEXT`);
  await exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS relevance DOUBLE PRECISION NOT NULL DEFAULT 1`);
  await exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB`);

  schemaEnsured = true;
}

function toMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    text: String(row.text),
    source: (row.source as string | null) ?? null,
    relevance: typeof row.relevance === 'number' ? row.relevance : Number(row.relevance ?? 1),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Persists a structured memory.
 *
 * - Refuses (with `blocked: true`) anything that looks like a secret or
 *   credential — it is never stored, even transiently.
 * - Deduplicates: if an existing memory with the same normalized text
 *   and kind already exists, that record is reused (`deduped: true`)
 *   instead of inserting a near-identical row.
 * - If no database is configured, returns an honest in-memory-only
 *   result (`persisted: false`) rather than pretending to save.
 * - If the database operation itself fails, the error is surfaced via
 *   `persisted: false` and `reason`, never faked as success.
 */
export async function saveMemory(
  text: string,
  kind = 'long_term',
  options: SaveMemoryOptions = {}
): Promise<SaveMemoryResult> {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return {
      id: `mem_${randomUUID()}`,
      text,
      kind,
      persisted: false,
      deduped: false,
      blocked: false,
      reason: 'Refused to save empty memory text.',
    };
  }

  if (looksLikeSecret(trimmed)) {
    return {
      id: `mem_${randomUUID()}`,
      text: trimmed,
      kind,
      persisted: false,
      deduped: false,
      blocked: true,
      reason: 'Refused to store: content looks like a secret/credential, not a memory.',
    };
  }

  if (!hasPg()) {
    return {
      id: `mem_${randomUUID()}`,
      text: trimmed,
      kind,
      persisted: false,
      deduped: false,
      blocked: false,
      reason: 'No DATABASE_URL configured; memory was not persisted.',
    };
  }

  try {
    await ensureSchema();

    const normalized = normalize(trimmed);

    // Best-effort de-dup: same kind + same normalized text, most recent first.
    const existing = await query<{ id: string; text: string; kind: string }>(
      `SELECT id, text, kind FROM memories WHERE kind = $1 AND lower(regexp_replace(text, '\\s+', ' ', 'g')) = $2
       ORDER BY created_at DESC LIMIT 1`,
      [kind, normalized]
    );

    if (existing[0]) {
      return {
        id: existing[0].id,
        text: existing[0].text,
        kind: existing[0].kind,
        persisted: true,
        deduped: true,
        blocked: false,
        reason: 'An equivalent memory already existed; reused it instead of duplicating.',
      };
    }

    const id = `mem_${randomUUID()}`;
    const relevance = typeof options.relevance === 'number' ? options.relevance : 1;
    const source = options.source ?? null;
    const metadata = options.metadata ? JSON.stringify(options.metadata) : null;

    await exec(
      `INSERT INTO memories (id, kind, text, source, relevance, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, kind, trimmed, source, relevance, metadata]
    );

    return { id, text: trimmed, kind, persisted: true, deduped: false, blocked: false };
  } catch (error) {
    console.error('saveMemory failed:', error);
    return {
      id: `mem_${randomUUID()}`,
      text: trimmed,
      kind,
      persisted: false,
      deduped: false,
      blocked: false,
      reason: `Database error while saving memory: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

/**
 * Searches memories by substring match on their text, optionally
 * filtered by kind, ordered by relevance then recency.
 *
 * Returns an empty array when no database is configured, or when the
 * query fails — this function never throws for read-path issues, since
 * a failed search should safely degrade to "no memories found" rather
 * than crashing a caller.
 */
export async function searchMemory(
  term: string,
  options: SearchMemoryOptions = {}
): Promise<MemoryRecord[]> {
  const trimmedTerm = typeof term === 'string' ? term.trim() : '';
  if (!trimmedTerm || !hasPg()) return [];

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  try {
    await ensureSchema();

    const rows = options.kind
      ? await query<Record<string, unknown>>(
          `SELECT * FROM memories WHERE kind = $1 AND text ILIKE $2
           ORDER BY relevance DESC, created_at DESC LIMIT $3`,
          [options.kind, `%${trimmedTerm}%`, limit]
        )
      : await query<Record<string, unknown>>(
          `SELECT * FROM memories WHERE text ILIKE $1
           ORDER BY relevance DESC, created_at DESC LIMIT $2`,
          [`%${trimmedTerm}%`, limit]
        );

    return rows.map(toMemoryRecord);
  } catch (error) {
    console.error('searchMemory failed:', error);
    return [];
  }
}
