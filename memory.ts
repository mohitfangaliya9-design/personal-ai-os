import { exec, query } from './db.js';
import { randomUUID } from 'node:crypto';

export async function saveMemory(text: string, kind = 'long_term') {
  if (!process.env.DATABASE_URL) return { id: `mem_${randomUUID()}`, text, kind, persisted: false };
  await exec(`CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const id = `mem_${randomUUID()}`;
  await exec(`INSERT INTO memories (id,kind,text) VALUES ($1,$2,$3)`, [id, kind, text]);
  return { id, text, kind, persisted: true };
}
export async function searchMemory(term: string) {
  if (!process.env.DATABASE_URL) return [];
  await exec(`CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  return query(`SELECT * FROM memories WHERE text ILIKE $1 ORDER BY created_at DESC LIMIT 20`, [`%${term}%`]);
}
