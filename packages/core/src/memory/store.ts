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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gitHeadSha, resolveDbPath } from '../index/indexer.js';
import { IndexLimits } from '../types.js';
import {
  clearMemoryLsh,
  indexMemoryLsh,
  memoryLshCandidateIds,
} from '../search/ann.js';

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
  /** Commit the memory was recorded against (null outside git). */
  headSha?: string | null;
  /** True when a referenced file changed since the memory was saved. */
  stale?: boolean;
}

export interface RecallOptions {
  topK?: number;
  /** Paths from the current retrieval — memories touching them are boosted. */
  scopePaths?: string[];
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
  head_sha?: string | null;
  path_hashes?: string | null;
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
    headSha: row.head_sha ?? null,
  };
}

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** `path:hash` pairs so recall can tell when a memory's code moved on. */
function hashPaths(workspace: string, paths: string[]): string {
  const out: string[] = [];
  for (const rel of paths) {
    const abs = isAbsolute(rel) ? rel : join(workspace, rel);
    try {
      if (existsSync(abs)) out.push(`${rel}:${shortHash(readFileSync(abs, 'utf8'))}`);
    } catch {
      /* unreadable — no provenance for this path */
    }
  }
  return out.join(',');
}

/** A memory is stale when any referenced file no longer matches its saved hash. */
export function memoryIsStale(workspace: string, row: MemoryRow): boolean {
  const raw = row.path_hashes ?? '';
  if (!raw) return false;
  for (const pair of raw.split(',').filter(Boolean)) {
    const idx = pair.lastIndexOf(':');
    if (idx <= 0) continue;
    const rel = pair.slice(0, idx);
    const expected = pair.slice(idx + 1);
    const abs = isAbsolute(rel) ? rel : join(workspace, rel);
    try {
      if (!existsSync(abs)) return true;
      if (shortHash(readFileSync(abs, 'utf8')) !== expected) return true;
    } catch {
      return true;
    }
  }
  return false;
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

/** Cosine above this means "the same memory, said differently" — merge them. */
const NEAR_DUPLICATE_COSINE = 0.9;
/** Recall scoring weights: semantic relevance, recency, proven usefulness. */
const SCORE_WEIGHTS = { semantic: 0.6, recency: 0.25, useCount: 0.15 } as const;
const RECENCY_HALF_LIFE_DAYS = 30;
/** Memories scoring below this after decay are dropped on write. */
const PRUNE_SCORE_FLOOR = 0.02;
const PRUNE_MIN_AGE_DAYS = 60;
/** Memories whose paths overlap the current work get this multiplier. */
const SCOPE_BOOST = 1.5;
/** Off-scope memories must clear this to be injected at all. */
const OFF_SCOPE_FLOOR = 0.08;

function recencyScore(iso: string | null): number {
  if (!iso) return 0;
  const ageDays = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  return Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALF_LIFE_DAYS);
}

function findNearDuplicate(
  db: Database.Database,
  vec: Float32Array,
  kind: MemoryKind,
): MemoryRow | null {
  const candidateIds = memoryLshCandidateIds(db, vec);
  if (!candidateIds.length) return null;
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE kind = ? AND id IN (${candidateIds
        .map(() => '?')
        .join(',')})`,
    )
    .all(kind, ...candidateIds) as MemoryRow[];
  let best: { row: MemoryRow; score: number } | null = null;
  for (const row of rows) {
    if (!row.embedding) continue;
    const other = blobToVec(row.embedding);
    if (other.length !== vec.length) continue;
    const score = cosine(vec, other);
    if (score >= NEAR_DUPLICATE_COSINE && (!best || score > best.score)) {
      best = { row, score };
    }
  }
  return best?.row ?? null;
}

/** Drop stale, unused, low-value memories. Cheap, runs on write. */
function pruneDecayedMemories(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, created_at, last_used_at, use_count FROM memories WHERE kind != 'session'`,
    )
    .all() as Array<{
    id: number;
    created_at: string;
    last_used_at: string | null;
    use_count: number;
  }>;
  const doomed: number[] = [];
  for (const row of rows) {
    const ageDays = (Date.now() - Date.parse(row.created_at)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < PRUNE_MIN_AGE_DAYS) continue;
    const score =
      SCORE_WEIGHTS.recency * recencyScore(row.last_used_at ?? row.created_at) +
      SCORE_WEIGHTS.useCount * Math.min(1, row.use_count / 5);
    if (score < PRUNE_SCORE_FLOOR) doomed.push(row.id);
  }
  for (const id of doomed) {
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(id);
    clearMemoryLsh(db, id);
  }
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

    // Consolidate near-duplicates instead of stacking paraphrases.
    const twin = findNearDuplicate(db, vec, input.kind);
    if (twin) {
      const merged = twin.text.length >= text.length ? twin.text : text;
      db.prepare(
        `UPDATE memories SET text = ?, use_count = use_count + 1, last_used_at = ?,
           head_sha = ?, path_hashes = ? WHERE id = ?`,
      ).run(
        merged,
        new Date().toISOString(),
        gitHeadSha(workspace),
        hashPaths(workspace, input.paths ?? []),
        twin.id,
      );
      db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(twin.id);
      db.prepare(
        `INSERT INTO memories_fts(rowid, text, tags, paths) VALUES (?, ?, ?, ?)`,
      ).run(twin.id, merged, twin.tags, twin.paths);
      const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(twin.id) as MemoryRow;
      return rowToEntry(row);
    }

    const info = db
      .prepare(
        `INSERT INTO memories(kind, text, tags, paths, created_at, use_count, embedding,
                              head_sha, path_hashes)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.kind,
        text,
        tags,
        paths,
        new Date().toISOString(),
        vecToBlob(vec),
        gitHeadSha(workspace),
        hashPaths(workspace, input.paths ?? []),
      );
    const id = Number(info.lastInsertRowid);
    indexMemoryLsh(db, id, vec);
    db.prepare(`INSERT INTO memories_fts(rowid, text, tags, paths) VALUES (?, ?, ?, ?)`).run(
      id,
      text,
      tags,
      paths,
    );
    if (input.kind === 'session') pruneSessionMemories(db);
    else pruneDecayedMemories(db);
    const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow;
    return rowToEntry(row);
  });
}

export async function recallMemories(
  workspace: string,
  query: string,
  topKOrOptions: number | RecallOptions = DEFAULT_RECALL_TOP_K,
): Promise<MemoryEntry[]> {
  const options: RecallOptions =
    typeof topKOrOptions === 'number' ? { topK: topKOrOptions } : topKOrOptions;
  const k = Math.max(1, Math.min(options.topK ?? DEFAULT_RECALL_TOP_K, MAX_RECALL_TOP_K));
  const scope = new Set(options.scopePaths ?? []);
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

    // Candidates come from ANN buckets + FTS, not a full table scan.
    const candidateIds = new Set<number>([...ftsIds, ...memoryLshCandidateIds(db, qVec)]);
    const rows = candidateIds.size
      ? (db
          .prepare(
            `SELECT * FROM memories WHERE id IN (${[...candidateIds].map(() => '?').join(',')})`,
          )
          .all(...candidateIds) as MemoryRow[])
      : (db
          .prepare(`SELECT * FROM memories ORDER BY id DESC LIMIT ?`)
          .all(k * 5) as MemoryRow[]);

    const ftsRank = new Map(ftsIds.map((id, i) => [id, i]));
    const scored: Array<{ row: MemoryRow; score: number }> = [];
    for (const row of rows) {
      let semantic = 0;
      if (row.embedding) {
        const vec = blobToVec(row.embedding);
        if (vec.length === qVec.length) semantic = cosine(qVec, vec);
      }
      const lexical = ftsRank.has(row.id)
        ? 1 / (IndexLimits.RRF_K + ftsRank.get(row.id)! + 1)
        : 0;
      let score =
        SCORE_WEIGHTS.semantic * Math.max(semantic, lexical * IndexLimits.RRF_K) +
        SCORE_WEIGHTS.recency * recencyScore(row.last_used_at ?? row.created_at) +
        SCORE_WEIGHTS.useCount * Math.min(1, row.use_count / 5);

      const paths = row.paths ? row.paths.split(',').filter(Boolean) : [];
      const inScope = scope.size > 0 && paths.some((p) => scope.has(p));
      if (inScope) score *= SCOPE_BOOST;
      // Only apply the off-scope floor to memories that explicitly declare
      // paths — a memory with no paths is workspace-global (e.g. auto session
      // summaries) and should not be penalised for being "off-scope".
      else if (scope.size > 0 && paths.length > 0 && score < OFF_SCOPE_FLOOR) continue;

      if (score <= 0) continue;
      scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, k);
    if (!picked.length) return [];

    const now = new Date().toISOString();
    const touch = db.prepare(
      `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
    );
    return picked.map(({ row }) => {
      touch.run(now, row.id);
      return { ...rowToEntry(row), stale: memoryIsStale(workspace, row) };
    });
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
