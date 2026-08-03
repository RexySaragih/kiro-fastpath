import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { IndexLimits } from '../types.js';

const require = createRequire(import.meta.url);

const LSH_TABLES = 8;
const LSH_BITS = 12;

/** Deterministic random hyperplanes for LSH (seeded, offline). */
function hyperplanes(dim: number, count: number): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const plane = new Float32Array(dim);
    for (let d = 0; d < dim; d++) {
      const h = createHash('sha256').update(`fp-lsh-${i}-${d}`).digest();
      const u = h.readUInt32BE(0) / 0xffffffff;
      plane[d] = u * 2 - 1;
    }
    planes.push(plane);
  }
  return planes;
}

function hashBucket(vec: Float32Array, planes: Float32Array[]): number {
  let bits = 0;
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i]!;
    let dot = 0;
    const n = Math.min(vec.length, plane.length);
    for (let d = 0; d < n; d++) dot += vec[d]! * plane[d]!;
    if (dot >= 0) bits |= 1 << i;
  }
  return bits;
}

let planeCache: { dim: number; tables: Float32Array[][] } | null = null;

function planesForDim(dim: number): Float32Array[][] {
  if (planeCache?.dim === dim) return planeCache.tables;
  const tables: Float32Array[][] = [];
  for (let t = 0; t < LSH_TABLES; t++) {
    tables.push(hyperplanes(dim, LSH_BITS));
  }
  planeCache = { dim, tables };
  return tables;
}

export function indexVectorLsh(
  db: Database.Database,
  symbolId: number,
  vec: Float32Array,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vector_lsh(table_id, bucket, symbol_id) VALUES (?, ?, ?)`,
  );
  const tables = planesForDim(vec.length);
  for (let t = 0; t < tables.length; t++) {
    const bucket = hashBucket(vec, tables[t]!);
    insert.run(t, bucket, symbolId);
  }
}

export function clearLshForSymbol(db: Database.Database, symbolId: number): void {
  db.prepare(`DELETE FROM vector_lsh WHERE symbol_id = ?`).run(symbolId);
}

/** Candidate symbol ids via LSH (union of matching buckets). */
export function lshCandidateIds(
  db: Database.Database,
  query: Float32Array,
  limit = IndexLimits.VECTOR_SCAN_LIMIT,
): number[] {
  const tables = planesForDim(query.length);
  const ids = new Set<number>();
  const stmt = db.prepare(
    `SELECT symbol_id FROM vector_lsh WHERE table_id = ? AND bucket = ? LIMIT 200`,
  );
  for (let t = 0; t < tables.length; t++) {
    const bucket = hashBucket(query, tables[t]!);
    const rows = stmt.all(t, bucket) as Array<{ symbol_id: number }>;
    for (const row of rows) {
      ids.add(row.symbol_id);
      if (ids.size >= limit) return [...ids];
    }
  }
  return [...ids];
}

/** Try sqlite-vec if installed; returns true when vec0 virtual table is ready. */
export function tryEnableSqliteVec(db: Database.Database, dim: number): boolean {
  try {
    const sqliteVec = require('sqlite-vec') as {
      load: (db: Database.Database) => void;
    };
    sqliteVec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
        symbol_id INTEGER PRIMARY KEY,
        embedding float[${dim}]
      );
    `);
    return true;
  } catch {
    return false;
  }
}

export function insertSqliteVec(
  db: Database.Database,
  symbolId: number,
  vec: Float32Array,
): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO vec_symbols(symbol_id, embedding) VALUES (?, ?)`,
    ).run(symbolId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  } catch {
    /* vec table may be absent */
  }
}

export function querySqliteVec(
  db: Database.Database,
  query: Float32Array,
  topK: number,
): Array<{ symbol_id: number; distance: number }> {
  try {
    return db
      .prepare(
        `SELECT symbol_id, distance
         FROM vec_symbols
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), topK) as Array<{
      symbol_id: number;
      distance: number;
    }>;
  } catch {
    return [];
  }
}

export function sqliteVecAvailable(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_symbols'`,
      )
      .get() as { name: string } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}
