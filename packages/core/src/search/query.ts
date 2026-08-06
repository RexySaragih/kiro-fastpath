import type Database from 'better-sqlite3';
import { getMeta, openDatabase } from '../db/schema.js';
import { embedQuery } from '../embed/backend.js';
import { blobToVec, cosine } from '../embed/hash.js';
import { resolveDbPath } from '../index/indexer.js';
import { clampTopK, tokenizeIdentifier } from '../tokenize.js';
import {
  DEFAULT_MAX_CHUNKS,
  DEFAULT_TOP_K,
  HARD_MAX_CHUNKS,
  HARD_MAX_TOP_K,
  IndexLimits,
  InjectLimits,
  type SearchHit,
  type SearchOptions,
} from '../types.js';
import { enrichHitsWithWindows } from '../window.js';
// IndexLimits used for RERANK_CANDIDATES + VECTOR_SCAN_LIMIT
import { lshCandidateIds, querySqliteVec, sqliteVecAvailable } from './ann.js';
import { grepFast } from './grep.js';
import { rerankHits } from './rerank.js';
import { classifyQuery, fuseRrf } from './rrf.js';

/** Small domain map so "login" reaches auth code and vice versa. */
const QUERY_SYNONYMS: Record<string, string[]> = {
  auth: ['login', 'signin', 'authenticate', 'authentication'],
  login: ['auth', 'signin', 'authenticate'],
  signin: ['login', 'auth'],
  logout: ['signout', 'auth'],
  token: ['jwt', 'session'],
  jwt: ['token'],
  password: ['credential', 'secret'],
  db: ['database', 'sql', 'repository'],
  config: ['settings', 'options'],
  delete: ['remove', 'destroy'],
  create: ['add', 'insert'],
  update: ['edit', 'patch'],
};

const MAX_EXPANDED_TERMS = 24;

/**
 * Query-side expansion: identifiers are tokenized at index time, so do the same
 * to queries (`validateJwt` ⇄ "validate jwt") and add a few domain synonyms.
 */
export function expandQueryTerms(query: string): string[] {
  const cleaned = query
    .replace(/["']/g, ' ')
    .replace(/[*:^(){}[\]~-]/g, ' ')
    .trim();
  if (!cleaned) return [];
  const terms = new Set<string>();
  for (const raw of cleaned.split(/\s+/).filter(Boolean)) {
    terms.add(raw);
    for (const piece of tokenizeIdentifier(raw).split(/\s+/)) {
      if (piece.length > 1) terms.add(piece);
    }
  }
  for (const term of [...terms]) {
    for (const syn of QUERY_SYNONYMS[term.toLowerCase()] ?? []) terms.add(syn);
  }
  return [...terms].slice(0, MAX_EXPANDED_TERMS);
}

function escapeFts(query: string): string {
  const terms = expandQueryTerms(query);
  if (!terms.length) return '""';
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
  let chunkRows: Array<{
    path: string;
    symbol: string;
    kind: string;
    line: number;
    snip: string;
    rank: number;
  }> = [];

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

    // Body matches come from chunks (line-anchored) rather than whole files.
    chunkRows = db
      .prepare(
        `SELECT c.path, s.name AS symbol, s.kind, c.start_line AS line,
                snippet(chunks_fts, 1, '', '', '…', 24) AS snip,
                bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.symbol_id = chunks_fts.rowid
         JOIN symbols s ON s.id = c.symbol_id
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, topK * 2) as typeof chunkRows;

    // Files with no extracted symbols (config, docs) still need a way in.
    fileRows = db
      .prepare(
        `SELECT f.path, snippet(files_fts, 1, '', '', '…', 12) AS snip,
                bm25(files_fts) AS rank
         FROM files_fts f
         WHERE files_fts MATCH ?
           AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.path = f.path)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, topK) as typeof fileRows;
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
  for (const row of chunkRows) {
    if (pathPrefix && !row.path.startsWith(pathPrefix)) continue;
    hits.push({
      path: row.path,
      symbol: row.symbol,
      kind: row.kind,
      line: row.line,
      score: -row.rank * 0.9,
      snippet: row.snip,
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
  // Symbol-FTS and chunk-FTS can surface the same span; keep the best-scoring one.
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.path}:${hit.line ?? 0}:${hit.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
  }
  return deduped.slice(0, topK);
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
  let hits: SearchHit[];
  try {
    const kind = classifyQuery(query);
    const lexical = lexicalSearch(db, query, topK, options.pathPrefix);
    if (kind === 'identifier') {
      hits = lexical.slice(0, topK);
    } else {
      const candidates = options.rerankCandidates ?? IndexLimits.RERANK_CANDIDATES;
      const vectors = await vectorSearch(db, query, topK, options.pathPrefix);
      const fused = vectors.length
        ? fuseRrf([lexical, vectors], candidates)
        : lexical.slice(0, candidates);
      hits = await rerankHits(query, fused, topK);
    }
  } finally {
    db.close();
  }
  return enrichHitsWithWindows(workspace, hits);
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

    const hits = rows.map((row, i) => ({
      path: row.path,
      symbol: row.name,
      kind: row.kind,
      line: row.line,
      score: topK - i,
      snippet: row.signature,
    }));
    return enrichHitsWithWindows(workspace, hits);
  });
}

/** ~4 chars per token; context packs are budgeted in tokens, not hit counts. */
const CHARS_PER_TOKEN = 4;
export const CONTEXT_TOKEN_BUDGET = InjectLimits.TOKEN_BUDGET;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Merge hits that land in the same file into one hunk with a line-range list,
 * so several symbols from one file no longer ship overlapping ±3-line windows.
 */
function mergePerFile(hits: SearchHit[]): SearchHit[] {
  const byPath = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const list = byPath.get(hit.path) ?? [];
    list.push(hit);
    byPath.set(hit.path, list);
  }
  const merged: SearchHit[] = [];
  for (const [, list] of byPath) {
    const best = list[0]!;
    if (list.length === 1) {
      merged.push(best);
      continue;
    }
    const lines = [...new Set(list.map((h) => h.line).filter((l): l is number => !!l))].sort(
      (a, b) => a - b,
    );
    const symbols = [...new Set(list.map((h) => h.symbol).filter(Boolean))];
    merged.push({
      ...best,
      symbol: symbols.join(', ') || best.symbol,
      snippet: [
        lines.length ? `lines ${lines.join(', ')}` : '',
        list
          .map((h) => h.snippet)
          .filter(Boolean)
          .join('\n---\n'),
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Deterministic recovery before giving up: pull identifiers and path-like
 * tokens out of the prompt and try exact symbol lookup, then content grep.
 * No model calls.
 */
export function zeroHitLadder(workspace: string, task: string, topK: number): SearchHit[] {
  const identifiers = [...new Set(task.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [])]
    .filter((t) => /[A-Z]|_/.test(t) || t.length > 6)
    .slice(0, 5);
  const paths = [...new Set(task.match(/[\w./-]+\.[a-zA-Z]{1,5}\b/g) ?? [])].slice(0, 3);

  const out: SearchHit[] = [];
  for (const name of identifiers) {
    try {
      out.push(...lookupSymbol(workspace, name, { topK: 2 }));
    } catch {
      /* ignore */
    }
    if (out.length >= topK) return out.slice(0, topK);
  }
  for (const term of [...paths, ...identifiers]) {
    try {
      out.push(...grepFast(workspace, term, { topK: 2 }));
    } catch {
      /* ignore */
    }
    if (out.length >= topK) break;
  }
  return out.slice(0, topK);
}

export async function contextForTask(
  workspace: string,
  task: string,
  maxChunks?: number,
): Promise<SearchHit[]> {
  const limit = clampTopK(maxChunks, DEFAULT_MAX_CHUNKS, HARD_MAX_CHUNKS);
  let hits = await searchIndex(workspace, task, {
    topK: limit,
    rerankCandidates: IndexLimits.RERANK_CANDIDATES_INJECT,
  });
  if (!hits.length) {
    hits = enrichHitsWithWindows(workspace, zeroHitLadder(workspace, task, limit));
  }

  // Budget by tokens, not hit count: merge per file, then fill until spent.
  const budgeted: SearchHit[] = [];
  let spent = 0;
  for (const hit of mergePerFile(hits)) {
    const cost = estimateTokens(`${hit.path}${hit.symbol ?? ''}${hit.snippet ?? ''}`);
    if (budgeted.length && spent + cost > CONTEXT_TOKEN_BUDGET) break;
    budgeted.push(hit);
    spent += cost;
  }

  if (budgeted[0]) {
    const edges = withWorkspaceDb(workspace, (db) =>
      db
        .prepare(`SELECT to_specifier, to_path FROM edges WHERE from_path = ? LIMIT 8`)
        .all(budgeted[0]!.path) as Array<{
        to_specifier: string;
        to_path: string | null;
      }>,
    );
    if (edges.length) {
      budgeted.push({
        path: budgeted[0].path,
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

  return budgeted.slice(0, limit + 1);
}

/**
 * Indexed file paths under a prefix. Lets the guardrail answer a blocked
 * directory walk from the index instead of only refusing it.
 */
export function listIndexedPaths(workspace: string, prefix = '', limit = 40): string[] {
  const clean = prefix.replace(/^\.\//, '').replace(/\/+$/, '');
  return withWorkspaceDb(workspace, (db) => {
    const rows = clean
      ? (db
          .prepare(`SELECT path FROM files WHERE path LIKE ? ORDER BY path LIMIT ?`)
          .all(`${clean}/%`, limit) as Array<{ path: string }>)
      : (db
          .prepare(`SELECT path FROM files ORDER BY path LIMIT ?`)
          .all(limit) as Array<{ path: string }>);
    if (rows.length || !clean) return rows.map((r) => r.path);
    // Tolerate absolute or partially-qualified prefixes.
    return (
      db
        .prepare(`SELECT path FROM files WHERE path LIKE ? ORDER BY path LIMIT ?`)
        .all(`%${clean}%`, limit) as Array<{ path: string }>
    ).map((r) => r.path);
  });
}

/**
 * Cheap recency pack: symbols from the most recently modified indexed files.
 * Used when there is no query (or no hits) — the hook cost is already paid,
 * so emit something useful instead of an empty block.
 */
export function recentSymbols(workspace: string, limit = 6): SearchHit[] {
  return withWorkspaceDb(workspace, (db) => {
    const rows = db
      .prepare(
        `SELECT s.path, s.name, s.kind, s.line, s.signature
         FROM symbols s
         JOIN files f ON f.path = s.path
         ORDER BY f.mtime_ms DESC, s.line ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      path: string;
      name: string;
      kind: string;
      line: number;
      signature: string;
    }>;
    const hits = rows.map((row, i) => ({
      path: row.path,
      symbol: row.name,
      kind: row.kind,
      line: row.line,
      score: limit - i,
      snippet: row.signature,
    }));
    return enrichHitsWithWindows(workspace, hits);
  });
}
