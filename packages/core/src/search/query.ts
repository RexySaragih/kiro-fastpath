import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getMeta, openDatabase } from '../db/schema.js';
import { embedQuery } from '../embed/backend.js';
import { blobToVec, cosine } from '../embed/hash.js';
import { resolveDbPath } from '../index/indexer.js';
import { clampTopK, snippetAround } from '../tokenize.js';
import {
  DEFAULT_MAX_CHUNKS,
  DEFAULT_TOP_K,
  HARD_MAX_CHUNKS,
  HARD_MAX_TOP_K,
  IndexLimits,
  type SearchHit,
  type SearchOptions,
} from '../types.js';
// IndexLimits used for RERANK_CANDIDATES + VECTOR_SCAN_LIMIT
import { lshCandidateIds, querySqliteVec, sqliteVecAvailable } from './ann.js';
import { rerankHits } from './rerank.js';
import { classifyQuery, fuseRrf } from './rrf.js';

function escapeFts(query: string): string {
  const cleaned = query
    .replace(/["']/g, ' ')
    .replace(/[*:^(){}[\]~-]/g, ' ')
    .trim();
  if (!cleaned) return '""';
  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 1) {
    const t = terms[0]!;
    return `"${t}" OR ${t}*`;
  }
  return terms.map((t) => `"${t}" OR ${t}*`).join(' OR ');
}

function withWorkspaceDb<T>(workspace: string, fn: (db: Database.Database) => T): T {
  const db = openDatabase(resolveDbPath(workspace), { create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function lexicalSearch(
  db: Database.Database,
  query: string,
  topK: number,
  pathPrefix?: string,
): SearchHit[] {
  const fts = escapeFts(query);
  let symbolRows: Array<{
    path: string;
    symbol: string;
    kind: string;
    line: number;
    signature: string;
    rank: number;
  }> = [];
  let fileRows: Array<{ path: string; snip: string; rank: number }> = [];

  try {
    symbolRows = db
      .prepare(
        `SELECT s.path, s.name AS symbol, s.kind, s.line, s.signature,
                bm25(symbols_fts) AS rank
         FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE symbols_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, topK * 3) as typeof symbolRows;

    fileRows = db
      .prepare(
        `SELECT path, snippet(files_fts, 1, '', '', '…', 12) AS snip,
                bm25(files_fts) AS rank
         FROM files_fts
         WHERE files_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, topK * 2) as typeof fileRows;
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const row of symbolRows) {
    if (pathPrefix && !row.path.startsWith(pathPrefix)) continue;
    hits.push({
      path: row.path,
      symbol: row.symbol,
      kind: row.kind,
      line: row.line,
      score: -row.rank,
      snippet: row.signature,
    });
  }
  for (const row of fileRows) {
    if (pathPrefix && !row.path.startsWith(pathPrefix)) continue;
    hits.push({
      path: row.path,
      symbol: null,
      kind: null,
      line: null,
      score: -row.rank * 0.8,
      snippet: row.snip,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

let mismatchWarned = false;

/** Guard against comparing query vectors from a different backend/dim than the index. */
function embedDimMatchesIndex(db: Database.Database, queryDim: number): boolean {
  const raw = getMeta(db, 'embed_dim');
  if (!raw) return true;
  const indexDim = Number(raw);
  if (Number.isNaN(indexDim) || indexDim === queryDim) return true;
  if (!mismatchWarned) {
    mismatchWarned = true;
    console.error(
      `[fastpath] embed backend mismatch: index dim=${indexDim}, query dim=${queryDim}. ` +
        `Falling back to lexical search. Re-index with matching FASTPATH_EMBED or run ` +
        `\`fastpath index --rebuild\`.`,
    );
  }
  return false;
}

async function vectorSearch(
  db: Database.Database,
  query: string,
  topK: number,
  pathPrefix?: string,
): Promise<SearchHit[]> {
  const q = await embedQuery(query);
  if (!embedDimMatchesIndex(db, q.length)) return [];

  if (sqliteVecAvailable(db)) {
    const rows = querySqliteVec(db, q, topK * 3);
    if (rows.length) {
      const scored: SearchHit[] = [];
      const lookup = db.prepare(
        `SELECT path, name, kind, line, signature FROM symbols WHERE id = ?`,
      );
      for (const row of rows) {
        const sym = lookup.get(row.symbol_id) as
          | {
              path: string;
              name: string;
              kind: string;
              line: number;
              signature: string;
            }
          | undefined;
        if (!sym) continue;
        if (pathPrefix && !sym.path.startsWith(pathPrefix)) continue;
        scored.push({
          path: sym.path,
          symbol: sym.name,
          kind: sym.kind,
          line: sym.line,
          score: 1 / (1 + row.distance),
          snippet: sym.signature,
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    }
  }

  const candidateIds = lshCandidateIds(db, q, IndexLimits.VECTOR_SCAN_LIMIT);
  let rows: Array<{
    id: number;
    path: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    embedding: Buffer;
  }>;

  if (candidateIds.length) {
    const placeholders = candidateIds.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT s.id, s.path, s.name, s.kind, s.line, s.signature, v.embedding
         FROM symbol_vectors v
         JOIN symbols s ON s.id = v.symbol_id
         WHERE s.id IN (${placeholders})`,
      )
      .all(...candidateIds) as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT s.id, s.path, s.name, s.kind, s.line, s.signature, v.embedding
         FROM symbol_vectors v
         JOIN symbols s ON s.id = v.symbol_id
         LIMIT ?`,
      )
      .all(IndexLimits.VECTOR_SCAN_LIMIT) as typeof rows;
  }

  const scored: SearchHit[] = [];
  for (const row of rows) {
    if (pathPrefix && !row.path.startsWith(pathPrefix)) continue;
    const score = cosine(q, blobToVec(row.embedding));
    if (score < IndexLimits.COSINE_MIN_SCORE) continue;
    scored.push({
      path: row.path,
      symbol: row.name,
      kind: row.kind,
      line: row.line,
      score,
      snippet: row.signature,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function searchIndex(
  workspace: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const topK = clampTopK(options.topK, DEFAULT_TOP_K, HARD_MAX_TOP_K);
  const db = openDatabase(resolveDbPath(workspace), { create: false });
  try {
    const kind = classifyQuery(query);
    const lexical = lexicalSearch(db, query, topK, options.pathPrefix);
    if (kind === 'identifier') return lexical.slice(0, topK);
    const vectors = await vectorSearch(db, query, topK, options.pathPrefix);
    const fused = vectors.length
      ? fuseRrf([lexical, vectors], IndexLimits.RERANK_CANDIDATES)
      : lexical.slice(0, IndexLimits.RERANK_CANDIDATES);
    return rerankHits(query, fused, topK);
  } finally {
    db.close();
  }
}

export function lookupSymbol(
  workspace: string,
  name: string,
  options: { kind?: string; topK?: number } = {},
): SearchHit[] {
  const topK = clampTopK(options.topK, DEFAULT_TOP_K, HARD_MAX_TOP_K);
  return withWorkspaceDb(workspace, (db) => {
    const like = `%${name}%`;
    const rows = options.kind
      ? (db
          .prepare(
            `SELECT path, name, kind, line, signature FROM symbols
             WHERE name LIKE ? AND kind = ?
             ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, length(name)
             LIMIT ?`,
          )
          .all(like, options.kind, name, `${name}%`, topK) as Array<{
          path: string;
          name: string;
          kind: string;
          line: number;
          signature: string;
        }>)
      : (db
          .prepare(
            `SELECT path, name, kind, line, signature FROM symbols
             WHERE name LIKE ?
             ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, length(name)
             LIMIT ?`,
          )
          .all(like, name, `${name}%`, topK) as Array<{
          path: string;
          name: string;
          kind: string;
          line: number;
          signature: string;
        }>);

    return rows.map((row, i) => ({
      path: row.path,
      symbol: row.name,
      kind: row.kind,
      line: row.line,
      score: topK - i,
      snippet: row.signature,
    }));
  });
}

export async function contextForTask(
  workspace: string,
  task: string,
  maxChunks?: number,
): Promise<SearchHit[]> {
  const limit = clampTopK(maxChunks, DEFAULT_MAX_CHUNKS, HARD_MAX_CHUNKS);
  const hits = await searchIndex(workspace, task, { topK: limit });
  const enriched: SearchHit[] = [];

  for (const hit of hits) {
    const abs = join(workspace, hit.path);
    if (hit.line && existsSync(abs)) {
      try {
        const content = readFileSync(abs, 'utf8');
        enriched.push({ ...hit, snippet: snippetAround(content, hit.line, 3) });
        continue;
      } catch {
        /* fall through */
      }
    }
    enriched.push(hit);
  }

  if (enriched[0]) {
    const edges = withWorkspaceDb(workspace, (db) =>
      db
        .prepare(`SELECT to_specifier, to_path FROM edges WHERE from_path = ? LIMIT 8`)
        .all(enriched[0]!.path) as Array<{
        to_specifier: string;
        to_path: string | null;
      }>,
    );
    if (edges.length) {
      enriched.push({
        path: enriched[0].path,
        symbol: null,
        kind: 'imports',
        line: null,
        score: 0,
        snippet: edges
          .map((e) => (e.to_path ? `${e.to_specifier} → ${e.to_path}` : e.to_specifier))
          .join(', '),
      });
    }
  }

  return enriched.slice(0, limit + 1);
}
