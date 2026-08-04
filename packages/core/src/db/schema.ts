import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HASH_EMBED_DIM } from '../embed/hash.js';

/** Bump when on-disk shape changes; doctor refuses silent lies. */
export const CURRENT_SCHEMA_VERSION = 5;

/** Wait this long on SQLITE_BUSY before failing (watch + inject + index). */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  /** When false, refuse to create a missing DB (status/doctor/search). Default true. */
  create?: boolean;
}

export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): Database.Database {
  const create = options.create !== false;
  if (!existsSync(dbPath)) {
    if (!create) {
      throw new Error(`FastPath index not found at ${dbPath}. Run: fastpath index`);
    }
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT NOT NULL,
      tokens TEXT NOT NULL,
      FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name_lower ON symbols(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_path TEXT NOT NULL,
      to_path TEXT,
      to_specifier TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_path);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_path);

    CREATE TABLE IF NOT EXISTS ngrams (
      hash TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (hash, path)
    );

    CREATE INDEX IF NOT EXISTS idx_ngrams_hash ON ngrams(hash);

    CREATE TABLE IF NOT EXISTS symbol_vectors (
      symbol_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vector_lsh (
      table_id INTEGER NOT NULL,
      bucket INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      PRIMARY KEY (table_id, bucket, symbol_id)
    );

    CREATE INDEX IF NOT EXISTS idx_vector_lsh_lookup
      ON vector_lsh(table_id, bucket);

    CREATE TABLE IF NOT EXISTS call_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_path TEXT NOT NULL,
      from_symbol TEXT,
      to_name TEXT NOT NULL,
      to_path TEXT,
      line INTEGER NOT NULL,
      kind TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_call_to ON call_edges(to_name);
    CREATE INDEX IF NOT EXISTS idx_call_from ON call_edges(from_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      tokens,
      signature,
      path
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      path,
      body
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      paths TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      embedding BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      tags,
      paths
    );
  `);

  const existingDim = getMeta(db, 'embed_dim');
  if (!existingDim) setMeta(db, 'embed_dim', String(HASH_EMBED_DIM));

  const verRaw = getMeta(db, 'schema_version');
  const ver = verRaw ? Number(verRaw) : 0;
  if (!verRaw || Number.isNaN(ver)) {
    setMeta(db, 'schema_version', String(CURRENT_SCHEMA_VERSION));
  } else if (ver < CURRENT_SCHEMA_VERSION) {
    for (let v = ver + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      STEP_MIGRATIONS.get(v)?.(db);
    }
    setMeta(db, 'schema_version', String(CURRENT_SCHEMA_VERSION));
  }
  // If ver > CURRENT_SCHEMA_VERSION, leave as-is — doctor will flag.
}

/**
 * In-place step migrations keyed by target version, applied in order on open.
 * The base DDL above is idempotent (CREATE IF NOT EXISTS), so steps are only
 * needed for transforms it cannot express (column adds, backfills, renames).
 * v5 (memories tables) is purely additive — no step required.
 */
const STEP_MIGRATIONS: ReadonlyMap<number, (db: Database.Database) => void> = new Map();

export function getSchemaVersion(db: Database.Database): number {
  const raw = getMeta(db, 'schema_version');
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

export function checkDatabaseIntegrity(db: Database.Database): {
  ok: boolean;
  detail: string;
} {
  try {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const detail = rows.map((r) => r.integrity_check).join('; ') || 'unknown';
    return { ok: detail === 'ok', detail };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
