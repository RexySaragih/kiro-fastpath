/**
 * Project memory store — long-lived facts, decisions, and session summaries
 * kept beside the code index in `.fastpath/index.db`.
 * Recall fuses FTS (BM25) and embedding cosine via RRF so memories surface
 * for both exact terms and paraphrased queries.
 */
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/schema.js';
import { embedQuery } from '../embed/backend.js';
import { blobToVec, cosine, vecToBlob } from '../embed/hash.js';
import { resolveDbPath } from '../index/indexer.js';
import { IndexLimits } from '../types.js';

export type MemoryKind = 'decision' | 'fact' | 'preference' | 'session';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'decision',
  'fact',
  'preference',
  'session',
];

export interface MemoryEntry {
  id: number;
  kind: MemoryKind;
  text: string;
  tags: string[];
  paths: string[];
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface SaveMemoryInput {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  paths?: string[];
}

const DEFAULT_RECALL_TOP_K = 3;
const MAX_RECALL_TOP_K = 10;
const MAX_MEMORY_TEXT_CHARS = 2_000;
/** Session memories are rolling context, not durable knowledge — cap them. */
const MAX_SESSION_MEMORIES = 50;

interface MemoryRow {
  id: number;
  kind: string;
  text: string;
  tags: string;
  paths: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  embedding: Buffer | null;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    text: row.text,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    paths: row.paths ? row.paths.split(',').filter(Boolean) : [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

function withMemoryDb<T>(workspace: string, fn: (db: Database.Database) => T): T {
  const db = openDatabase(resolveDbPath(workspace));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function escapeFtsQuery(query: string): string {
  const cleaned = query.replace(/["'*:^(){}[\]~-]/g, ' ').trim();
  if (!cleaned) return '""';
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' OR ');
}

function pruneSessionMemories(db: Database.Database): void {
  db.prepare(
    `DELETE FROM memories WHERE kind = 'session' AND id NOT IN (
       SELECT id FROM memories WHERE kind = 'session' ORDER BY id DESC LIMIT ?
     )`,
  ).run(MAX_SESSION_MEMORIES);
  db.prepare(
    `DELETE FROM memories_fts WHERE rowid NOT IN (SELECT id FROM memories)`,
  ).run();
}

export async function saveMemory(
  workspace: string,
  input: SaveMemoryInput,
): Promise<MemoryEntry> {
  const text = input.text.trim().slice(0, MAX_MEMORY_TEXT_CHARS);
  if (!text) throw new Error('memory text is empty');
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean).join(',');
  const paths = (input.paths ?? []).map((p) => p.trim()).filter(Boolean).join(',');
  const vec = await embedQuery(text);

  return withMemoryDb(workspace, (db) => {
    const existing = db
      .prepare(`SELECT * FROM memories WHERE kind = ? AND text = ?`)
      .get(input.kind, text) as MemoryRow | undefined;
    if (existing) {
      db.prepare(
        `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), existing.id);
      return rowToEntry({ ...existing, use_count: existing.use_count + 1 });
    }

    const info = db
      .prepare(
        `INSERT INTO memories(kind, text, tags, paths, created_at, use_count, embedding)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(input.kind, text, tags, paths, new Date().toISOString(), vecToBlob(vec));
    const id = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO memories_fts(rowid, text, tags, paths) VALUES (?, ?, ?, ?)`).run(
      id,
      text,
      tags,
      paths,
    );
    if (input.kind === 'session') pruneSessionMemories(db);
    const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow;
    return rowToEntry(row);
  });
}

export async function recallMemories(
  workspace: string,
  query: string,
  topK = DEFAULT_RECALL_TOP_K,
): Promise<MemoryEntry[]> {
  const k = Math.max(1, Math.min(topK, MAX_RECALL_TOP_K));
  const qVec = await embedQuery(query);

  return withMemoryDb(workspace, (db) => {
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
    if (!total) return [];

    let ftsIds: number[] = [];
    try {
      ftsIds = (
        db
          .prepare(
            `SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
          )
          .all(escapeFtsQuery(query), k * 3) as Array<{ rowid: number }>
      ).map((r) => r.rowid);
    } catch {
      ftsIds = [];
    }

    const rows = db.prepare(`SELECT * FROM memories`).all() as MemoryRow[];
    const vecRanked = rows
      .filter((r) => r.embedding && blobToVec(r.embedding).length === qVec.length)
      .map((r) => ({ id: r.id, score: cosine(qVec, blobToVec(r.embedding!)) }))
      .filter((r) => r.score >= IndexLimits.COSINE_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k * 3)
      .map((r) => r.id);

    const rrf = new Map<number, number>();
    for (const list of [ftsIds, vecRanked]) {
      list.forEach((id, rank) => {
        rrf.set(id, (rrf.get(id) ?? 0) + 1 / (IndexLimits.RRF_K + rank + 1));
      });
    }

    const picked = [...rrf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id]) => id);
    if (!picked.length) return [];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const touch = db.prepare(
      `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
    );
    const out: MemoryEntry[] = [];
    for (const id of picked) {
      const row = byId.get(id);
      if (!row) continue;
      touch.run(now, id);
      out.push(rowToEntry(row));
    }
    return out;
  });
}

export function listMemories(workspace: string, limit = 100): MemoryEntry[] {
  return withMemoryDb(workspace, (db) => {
    const rows = db
      .prepare(`SELECT * FROM memories ORDER BY id DESC LIMIT ?`)
      .all(limit) as MemoryRow[];
    return rows.map(rowToEntry);
  });
}

export function forgetMemory(workspace: string, id: number): boolean {
  return withMemoryDb(workspace, (db) => {
    const changed = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes;
    db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(id);
    return changed > 0;
  });
}

/** Markdown digest of the most durable memories (for steering distillation). */
export function distillMemories(workspace: string, maxEntries = 30): string {
  const entries = withMemoryDb(workspace, (db) => {
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE kind != 'session'
         ORDER BY use_count DESC, id DESC LIMIT ?`,
      )
      .all(maxEntries) as MemoryRow[];
    return rows.map(rowToEntry);
  });

  const lines = [
    '---',
    'inclusion: manual',
    '---',
    '',
    '# FastPath project memory (distilled)',
    '',
    'Reference with `#fastpath-memory` when historical decisions matter.',
    '',
  ];
  for (const m of entries) {
    const paths = m.paths.length ? ` — \`${m.paths.join('`, `')}\`` : '';
    lines.push(`- **${m.kind}**: ${m.text}${paths}`);
  }
  if (!entries.length) lines.push('_No durable memories yet._');
  return `${lines.join('\n')}\n`;
}
