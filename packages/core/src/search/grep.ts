import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/schema.js';
import { resolveDbPath } from '../index/indexer.js';
import { buildCovering, literalsFromPattern, ngramHash } from '../ngram/sparse.js';
import { clampTopK, snippetAround } from '../tokenize.js';
import {
  DEFAULT_TOP_K,
  HARD_MAX_TOP_K,
  IndexLimits,
  type SearchHit,
} from '../types.js';

function intersectSets(sets: Set<string>[]): Set<string> {
  if (!sets.length) return new Set();
  let out = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    const next = sets[i]!;
    out = new Set([...out].filter((p) => next.has(p)));
  }
  return out;
}

function pathsForLiteral(db: Database.Database, lit: string): Set<string> {
  const ngrams = buildCovering(lit);
  const pathSets: Set<string>[] = [];
  for (const ng of ngrams.slice(0, IndexLimits.MAX_COVERING_NGRAMS)) {
    const rows = db
      .prepare(`SELECT path FROM ngrams WHERE hash = ?`)
      .all(ngramHash(ng)) as Array<{ path: string }>;
    pathSets.push(new Set(rows.map((r) => r.path)));
  }

  const nonEmpty = pathSets.filter((s) => s.size > 0);
  if (nonEmpty.length) {
    const hit = intersectSets(nonEmpty);
    if (hit.size > 0) return hit;
  }

  // Seed fallback when covering intersection is empty (selective n-grams)
  const seed = ngrams[0] ?? lit.slice(0, Math.min(3, lit.length));
  if (!seed) return new Set();
  const rows = db
    .prepare(`SELECT DISTINCT path FROM ngrams WHERE hash = ?`)
    .all(ngramHash(seed)) as Array<{ path: string }>;
  return new Set(rows.map((r) => r.path));
}

function candidatePaths(db: Database.Database, pattern: string): string[] {
  const literals = literalsFromPattern(pattern);
  if (!literals.length) {
    return (
      db
        .prepare(`SELECT path FROM files LIMIT ?`)
        .all(IndexLimits.GREP_FALLBACK_FILE_LIMIT) as Array<{ path: string }>
    ).map((r) => r.path);
  }

  // AND across literals — do not drop empty sets (that falsely widens results)
  const litSets = literals
    .slice(0, IndexLimits.MAX_GREP_LITERALS)
    .map((lit) => pathsForLiteral(db, lit));
  if (litSets.some((s) => s.size === 0)) return [];
  return [...intersectSets(litSets)];
}

export function grepFast(
  workspace: string,
  pattern: string,
  options: { topK?: number; pathPrefix?: string } = {},
): SearchHit[] {
  const topK = clampTopK(options.topK, DEFAULT_TOP_K, HARD_MAX_TOP_K);
  const db = openDatabase(resolveDbPath(workspace), { create: false });
  let paths: string[];
  try {
    paths = candidatePaths(db, pattern);
  } finally {
    db.close();
  }

  if (options.pathPrefix) {
    const prefix = options.pathPrefix;
    paths = paths.filter((p) => p.startsWith(prefix));
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  const hits: SearchHit[] = [];
  for (const path of paths) {
    const abs = join(workspace, path);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!regex.test(line)) continue;
      hits.push({
        path,
        symbol: null,
        kind: 'match',
        line: i + 1,
        score: 1,
        snippet: snippetAround(content, i + 1, 2),
      });
      if (hits.length >= topK) return hits;
    }
  }
  return hits;
}
