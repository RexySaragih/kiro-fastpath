import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getMeta, openDatabase, setMeta } from '../db/schema.js';
import { embedMany, getEmbedBackend, getEmbedDim, warmEmbedder } from '../embed/backend.js';
import { vecToBlob } from '../embed/hash.js';
import { IgnoreMatcher } from '../ignore.js';
import { buildAllNgrams, ngramHash } from '../ngram/sparse.js';
import { parseFileAst } from '../parse/treesitter.js';
import { resolveImport } from '../resolve-imports.js';
import {
  clearLshForSymbol,
  indexVectorLsh,
  insertSqliteVec,
  tryEnableSqliteVec,
} from '../search/ann.js';
import {
  INDEXABLE_EXTENSIONS,
  IndexLimits,
  SYMBOL_EXTENSIONS,
  type IndexStats,
} from '../types.js';

function extOf(relOrName: string): string {
  const base = relOrName.split('/').pop() ?? '';
  return base.includes('.') ? `.${base.split('.').pop()?.toLowerCase()}` : '';
}

export function resolveDbPath(workspace: string): string {
  return join(workspace, '.fastpath', 'index.db');
}

export function walkIndexableFiles(workspace: string): string[] {
  const ignore = new IgnoreMatcher(workspace);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (ignore.ignores(workspace, abs)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.includes('.')
        ? `.${entry.name.split('.').pop()?.toLowerCase()}`
        : '';
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
      out.push(abs);
    }
  };
  walk(workspace);
  return out;
}

function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toRel(workspace: string, abs: string): string {
  return relative(workspace, abs).split(sep).join('/');
}

export interface IndexResult {
  stats: IndexStats;
  filesIndexed: number;
  filesSkipped: number;
  embedBackend: string;
  embedDim: number;
}

function clearFileArtifacts(db: Database.Database, rel: string): void {
  const ids = (
    db.prepare(`SELECT id FROM symbols WHERE path = ?`).all(rel) as Array<{ id: number }>
  ).map((r) => r.id);
  for (const id of ids) clearLshForSymbol(db, id);
  db.prepare(
    `DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE path = ?)`,
  ).run(rel);
  try {
    db.prepare(
      `DELETE FROM vec_symbols WHERE symbol_id IN (SELECT id FROM symbols WHERE path = ?)`,
    ).run(rel);
  } catch {
    /* optional */
  }
  db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(rel);
  db.prepare(`DELETE FROM chunks WHERE path = ?`).run(rel);
  db.prepare(`DELETE FROM symbols_fts WHERE path = ?`).run(rel);
  db.prepare(`DELETE FROM symbols WHERE path = ?`).run(rel);
  db.prepare(`DELETE FROM edges WHERE from_path = ?`).run(rel);
  db.prepare(`DELETE FROM call_edges WHERE from_path = ?`).run(rel);
  db.prepare(`DELETE FROM files_fts WHERE path = ?`).run(rel);
  db.prepare(`DELETE FROM ngrams WHERE path = ?`).run(rel);
}

const CALL_CANDIDATE_LIMIT = 8;

/**
 * Resolve call edges to a definition path. Scoped to the files just indexed
 * (a full unresolved scan on every delta was wasted work) and no longer
 * requires a unique name: ambiguous names are ranked by import-edge proximity,
 * then same-file, so overloaded/duplicated method names still resolve.
 */
function resolveCallTargets(db: Database.Database, scopePaths?: string[]): void {
  const unresolved = scopePaths?.length
    ? (db
        .prepare(
          `SELECT id, to_name, from_path FROM call_edges
           WHERE to_path IS NULL AND from_path IN (${scopePaths.map(() => '?').join(',')})`,
        )
        .all(...scopePaths) as Array<{ id: number; to_name: string; from_path: string }>)
    : (db
        .prepare(`SELECT id, to_name, from_path FROM call_edges WHERE to_path IS NULL`)
        .all() as Array<{ id: number; to_name: string; from_path: string }>);
  if (!unresolved.length) return;

  const lookup = db.prepare(
    `SELECT DISTINCT path FROM symbols WHERE name = ? OR name LIKE ? LIMIT ?`,
  );
  const importsOf = db.prepare(
    `SELECT to_path FROM edges WHERE from_path = ? AND to_path IS NOT NULL`,
  );
  const update = db.prepare(`UPDATE call_edges SET to_path = ? WHERE id = ?`);
  const importCache = new Map<string, Set<string>>();

  for (const row of unresolved) {
    const candidates = (
      lookup.all(row.to_name, `%.${row.to_name}`, CALL_CANDIDATE_LIMIT) as Array<{
        path: string;
      }>
    ).map((r) => r.path);
    if (!candidates.length) continue;
    if (candidates.length === 1) {
      update.run(candidates[0]!, row.id);
      continue;
    }
    let imported = importCache.get(row.from_path);
    if (!imported) {
      imported = new Set(
        (importsOf.all(row.from_path) as Array<{ to_path: string }>).map((r) => r.to_path),
      );
      importCache.set(row.from_path, imported);
    }
    const best =
      candidates.find((p) => p === row.from_path) ??
      candidates.find((p) => imported!.has(p)) ??
      null;
    if (best) update.run(best, row.id);
  }
}

/** How many chars of the AST span go into the embedded/searchable chunk. */
const CHUNK_BODY_CHARS = 1000;
/** Lines scanned above a symbol for its leading docstring/comment. */
const DOC_LOOKBACK_LINES = 8;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|"""|'''|--)/;

export interface SymbolChunk {
  startLine: number;
  endLine: number;
  header: string;
  text: string;
}

/**
 * Build the natural-language chunk for one symbol:
 * `path > name(signature)` header + leading doc comment + first body chars.
 * Embedding this (instead of the identifier alone) is what lets a query like
 * "where do we validate token expiry" match code that never says "expiry"
 * in its name.
 */
export function buildSymbolChunk(
  rel: string,
  lines: string[],
  sym: { name: string; kind: string; signature: string; line: number; endLine: number },
): SymbolChunk {
  const startIdx = Math.max(0, sym.line - 1);
  const endIdx = Math.min(lines.length, Math.max(sym.endLine, sym.line));

  const doc: string[] = [];
  for (let i = startIdx - 1; i >= 0 && startIdx - i <= DOC_LOOKBACK_LINES; i--) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      if (doc.length) break;
      continue;
    }
    if (!COMMENT_LINE.test(line)) break;
    doc.unshift(line.trim());
  }

  const header = `${rel} > ${sym.name}(${sym.signature})`.slice(0, 300);
  const body = lines.slice(startIdx, endIdx).join('\n').slice(0, CHUNK_BODY_CHARS);
  return {
    startLine: sym.line,
    endLine: Math.max(sym.endLine, sym.line),
    header,
    text: [header, doc.join('\n'), body].filter(Boolean).join('\n'),
  };
}

interface IndexContext {
  db: Database.Database;
  workspace: string;
  knownFiles: Set<string>;
  vecEnabled: boolean;
}

async function indexOneFile(
  ctx: IndexContext,
  abs: string,
  options: { force?: boolean } = {},
): Promise<'indexed' | 'skipped'> {
  const { db, workspace, knownFiles, vecEnabled } = ctx;
  const rel = toRel(workspace, abs);
  let content: string;
  let st;
  try {
    st = statSync(abs);
    content = readFileSync(abs, 'utf8');
  } catch {
    return 'skipped';
  }
  if (content.length > IndexLimits.MAX_FILE_BYTES) return 'skipped';

  const hash = fileHash(content);
  const existing = db.prepare(`SELECT hash FROM files WHERE path = ?`);
  const prev = existing.get(rel) as { hash: string } | undefined;
  if (!options.force && prev?.hash === hash) return 'skipped';

  // Text-only extensions (config, docs, languages without a parser) get FTS +
  // n-grams so they are findable, but no symbol/vector work.
  const symbolic = SYMBOL_EXTENSIONS.has(extOf(rel));
  const parsed = symbolic
    ? await parseFileAst(rel, content)
    : { symbols: [], edges: [], calls: [], language: extOf(rel).replace('.', '') };
  const contentLines = content.split('\n');
  const chunks = parsed.symbols.map((sym) => buildSymbolChunk(rel, contentLines, sym));
  // Embed the chunk (header + doc + body), not just the identifier.
  const embedInputs = parsed.symbols.map(
    (sym, i) => `${sym.name} ${sym.kind}\n${chunks[i]?.text ?? sym.signature}`,
  );
  const vectors = embedInputs.length ? await embedMany(embedInputs) : [];

  const insertFile = db.prepare(
    `INSERT INTO files(path, hash, language, mtime_ms, size)
     VALUES (@path, @hash, @language, @mtime_ms, @size)
     ON CONFLICT(path) DO UPDATE SET
       hash=excluded.hash,
       language=excluded.language,
       mtime_ms=excluded.mtime_ms,
       size=excluded.size`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols(path, name, kind, line, end_line, signature, tokens)
     VALUES (@path, @name, @kind, @line, @end_line, @signature, @tokens)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO edges(from_path, to_path, to_specifier) VALUES (?, ?, ?)`,
  );
  const insertCall = db.prepare(
    `INSERT INTO call_edges(from_path, from_symbol, to_name, to_path, line, kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertFileFts = db.prepare(`INSERT INTO files_fts(path, body) VALUES (?, ?)`);
  const insertSymbolFts = db.prepare(
    `INSERT INTO symbols_fts(rowid, name, tokens, signature, path)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertNgram = db.prepare(
    `INSERT OR IGNORE INTO ngrams(hash, path) VALUES (?, ?)`,
  );
  const insertVec = db.prepare(
    `INSERT INTO symbol_vectors(symbol_id, dim, embedding) VALUES (?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks(symbol_id, path, start_line, end_line, header, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChunkFts = db.prepare(
    `INSERT INTO chunks_fts(rowid, header, text, path) VALUES (?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    clearFileArtifacts(db, rel);
    insertFile.run({
      path: rel,
      hash,
      language: parsed.language,
      mtime_ms: Math.floor(st.mtimeMs),
      size: st.size,
    });

    parsed.symbols.forEach((sym, i) => {
      const info = insertSymbol.run({
        path: rel,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        end_line: sym.endLine,
        signature: sym.signature,
        tokens: sym.tokens,
      });
      const id = Number(info.lastInsertRowid);
      insertSymbolFts.run(id, sym.name, sym.tokens, sym.signature, rel);
      const chunk = chunks[i];
      if (chunk) {
        insertChunk.run(id, rel, chunk.startLine, chunk.endLine, chunk.header, chunk.text);
        insertChunkFts.run(id, chunk.header, chunk.text, rel);
      }
      const vec = vectors[i];
      if (vec) {
        insertVec.run(id, vec.length, vecToBlob(vec));
        indexVectorLsh(db, id, vec);
        if (vecEnabled) insertSqliteVec(db, id, vec);
      }
    });

    for (const edge of parsed.edges) {
      const resolved = resolveImport(rel, edge.toSpecifier, knownFiles);
      insertEdge.run(rel, resolved, edge.toSpecifier);
    }

    for (const call of parsed.calls) {
      insertCall.run(
        rel,
        call.fromSymbol,
        call.toName,
        call.toPath,
        call.line,
        call.kind,
      );
    }

    const ngrams = buildAllNgrams(content.slice(0, IndexLimits.NGRAM_CONTENT_BYTES));
    let count = 0;
    for (const ng of ngrams) {
      if (ng.length < 2) continue;
      insertNgram.run(ngramHash(ng), rel);
      count += 1;
      if (count >= IndexLimits.MAX_NGRAMS_PER_FILE) break;
    }

    insertFileFts.run(rel, content.slice(0, IndexLimits.FILE_FTS_BODY_BYTES));
  });
  tx();
  return 'indexed';
}

/**
 * Open an index context. When `prewalkedFiles` (abs paths) is provided it seeds
 * `knownFiles`; otherwise known files come from the DB — this keeps single-file
 * deltas (watch / hooks / prompt-inject) from walking the whole tree.
 */
function openIndexContext(
  workspace: string,
  prewalkedFiles?: string[],
): IndexContext & {
  dbPath: string;
  embedBackend: string;
  embedDim: number;
} {
  const embedDim = getEmbedDim();
  const embedBackend = getEmbedBackend();
  const dbPath = resolveDbPath(workspace);
  const db = openDatabase(dbPath);
  const vecEnabled = tryEnableSqliteVec(db, embedDim);
  const knownFiles = prewalkedFiles
    ? new Set(prewalkedFiles.map((f) => toRel(workspace, f)))
    : new Set(
        (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
          (r) => r.path,
        ),
      );
  return {
    db,
    workspace,
    knownFiles,
    vecEnabled,
    dbPath,
    embedBackend,
    embedDim,
  };
}

/** Current HEAD sha, or null outside a git repo. */
export function gitHeadSha(workspace: string): string | null {
  const res = spawnSync('git', ['-C', resolve(workspace), 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

function finalizeIndex(
  ctx: IndexContext & { dbPath: string; embedBackend: string; embedDim: number },
  filesIndexed: number,
  filesSkipped: number,
  pruneMissing: boolean,
  scopePaths?: string[],
): IndexResult {
  const { db, workspace, dbPath, embedBackend, embedDim, vecEnabled } = ctx;
  if (pruneMissing) {
    const indexedPaths = new Set(
      walkIndexableFiles(workspace).map((f) => toRel(workspace, f)),
    );
    const stale = (
      db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>
    )
      .map((r) => r.path)
      .filter((p) => !indexedPaths.has(p));
    const remove = db.transaction((paths: string[]) => {
      const delFile = db.prepare(`DELETE FROM files WHERE path = ?`);
      for (const p of paths) {
        clearFileArtifacts(db, p);
        delFile.run(p);
      }
    });
    remove(stale);
  }

  resolveCallTargets(db, scopePaths);

  const now = new Date().toISOString();
  setMeta(db, 'workspace', workspace);
  setMeta(db, 'indexed_at', now);
  // Branch switches leave a clean working tree, so the index must remember
  // which commit it reflects (see catchUpHeadChange).
  const head = gitHeadSha(workspace);
  if (head) setMeta(db, 'head_sha', head);
  setMeta(db, 'embed_backend', embedBackend);
  setMeta(db, 'embed_dim', String(embedDim));
  setMeta(db, 'ann_backend', vecEnabled ? 'sqlite-vec+lsh' : 'lsh');

  const stats = readStats(db, workspace, dbPath);
  db.close();
  return { stats, filesIndexed, filesSkipped, embedBackend, embedDim };
}

/** Index specific absolute paths (delta / watch). Does not prune missing files. */
export async function indexWorkspacePaths(
  workspace: string,
  absPaths: string[],
): Promise<IndexResult> {
  await warmEmbedder();
  const ctx = openIndexContext(workspace);
  let filesIndexed = 0;
  let filesSkipped = 0;

  const unique = [...new Set(absPaths.map((p) => resolve(p)))];
  for (const abs of unique) ctx.knownFiles.add(toRel(workspace, abs));
  for (const abs of unique) {
    const result = await indexOneFile(ctx, abs, { force: true });
    if (result === 'indexed') filesIndexed += 1;
    else filesSkipped += 1;
  }

  return finalizeIndex(
    ctx,
    filesIndexed,
    filesSkipped,
    false,
    unique.map((abs) => toRel(workspace, abs)),
  );
}

/** Full workspace index with hash skip + prune. */
export async function indexWorkspace(workspace: string): Promise<IndexResult> {
  await warmEmbedder();
  const files = walkIndexableFiles(workspace);
  const ctx = openIndexContext(workspace, files);
  let filesIndexed = 0;
  let filesSkipped = 0;

  for (const abs of files) {
    const result = await indexOneFile(ctx, abs);
    if (result === 'indexed') filesIndexed += 1;
    else filesSkipped += 1;
  }

  return finalizeIndex(ctx, filesIndexed, filesSkipped, true);
}

/**
 * Candidate files for the per-prompt dirty check. In a git repo this is
 * `git status` (C-fast, includes untracked) instead of stat-ing the whole tree
 * on every turn; committed drift is reconciled at session start by
 * indexHeadChange. Outside git, fall back to the full walk.
 */
function dirtyCandidates(workspace: string): string[] {
  try {
    return listGitChangedFiles(workspace).changed;
  } catch {
    return walkIndexableFiles(workspace);
  }
}

/**
 * Find indexable files whose content differs from the DB (capped).
 * mtime+size are checked first so unchanged files skip the read+hash entirely.
 */
export function findDirtyFiles(
  workspace: string,
  maxFiles: number = IndexLimits.DELTA_MAX_FILES,
): string[] {
  const dbPath = resolveDbPath(workspace);
  if (!existsSync(dbPath)) return walkIndexableFiles(workspace).slice(0, maxFiles);

  const db = openDatabase(dbPath, { create: false });
  const dirty: string[] = [];
  try {
    const existing = db.prepare(
      `SELECT hash, mtime_ms, size FROM files WHERE path = ?`,
    );
    for (const abs of dirtyCandidates(workspace)) {
      if (dirty.length >= maxFiles) break;
      try {
        const st = statSync(abs);
        if (st.size > IndexLimits.MAX_FILE_BYTES) continue;
        const rel = toRel(workspace, abs);
        const prev = existing.get(rel) as
          | { hash: string; mtime_ms: number; size: number }
          | undefined;
        if (!prev) {
          dirty.push(abs);
          continue;
        }
        if (prev.mtime_ms === Math.floor(st.mtimeMs) && prev.size === st.size) {
          continue;
        }
        const content = readFileSync(abs, 'utf8');
        if (prev.hash !== fileHash(content)) dirty.push(abs);
      } catch {
        /* skip unreadable */
      }
    }
  } finally {
    db.close();
  }
  return dirty;
}

/**
 * Catch up after a branch switch. `git status --porcelain` is working-tree only,
 * so a checkout leaves a clean tree with entirely different content and a
 * confidently wrong index. Diff the recorded head against HEAD instead.
 */
export async function indexHeadChange(workspace: string): Promise<{
  from: string | null;
  to: string | null;
  filesIndexed: number;
  removed: number;
}> {
  const head = gitHeadSha(workspace);
  const dbPath = resolveDbPath(workspace);
  if (!head || !existsSync(dbPath)) {
    return { from: null, to: head, filesIndexed: 0, removed: 0 };
  }

  const db = openDatabase(dbPath, { create: false });
  let recorded: string | null;
  try {
    recorded = getMeta(db, 'head_sha');
  } finally {
    db.close();
  }
  if (!recorded || recorded === head) {
    return { from: recorded, to: head, filesIndexed: 0, removed: 0 };
  }

  const diff = spawnSync(
    'git',
    ['-C', resolve(workspace), 'diff', '--name-status', `${recorded}..HEAD`],
    { encoding: 'utf8' },
  );
  if (diff.status !== 0) {
    return { from: recorded, to: head, filesIndexed: 0, removed: 0 };
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  for (const line of diff.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const status = parts[0]!;
    const rel = (status.startsWith('R') ? parts[2] : parts[1])!;
    if (!isIndexableRel(rel)) continue;
    const abs = resolve(workspace, rel);
    if (status.startsWith('D') || !existsSync(abs)) deleted.push(rel);
    else changed.push(abs);
  }

  const removed = removeIndexedPaths(workspace, deleted);
  let filesIndexed = 0;
  if (changed.length) {
    filesIndexed = (await indexWorkspacePaths(workspace, changed)).filesIndexed;
  } else {
    const fresh = openDatabase(dbPath, { create: false });
    try {
      setMeta(fresh, 'head_sha', head);
    } finally {
      fresh.close();
    }
  }
  return { from: recorded, to: head, filesIndexed, removed };
}

/** Remove deleted paths from the index (watch / git deletes). */
export function removeIndexedPaths(workspace: string, relOrAbsPaths: string[]): number {
  if (!relOrAbsPaths.length) return 0;
  const dbPath = resolveDbPath(workspace);
  if (!existsSync(dbPath)) return 0;
  const db = openDatabase(dbPath, { create: false });
  try {
    const rels = relOrAbsPaths.map((p) => {
      const norm = p.split('\\').join('/');
      if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
        return toRel(workspace, resolve(p));
      }
      return norm;
    });
    const unique = [...new Set(rels)];
    const remove = db.transaction((paths: string[]) => {
      const delFile = db.prepare(`DELETE FROM files WHERE path = ?`);
      for (const p of paths) {
        clearFileArtifacts(db, p);
        delFile.run(p);
      }
    });
    remove(unique);
    setMeta(db, 'indexed_at', new Date().toISOString());
    return unique.length;
  } finally {
    db.close();
  }
}

function isIndexableRel(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  const ext = base.includes('.') ? `.${base.split('.').pop()?.toLowerCase()}` : '';
  return INDEXABLE_EXTENSIONS.has(ext);
}

/**
 * Absolute paths of git-changed indexable files (modified/added/untracked).
 * Throws if workspace is not a git repo.
 */
export function listGitChangedFiles(workspace: string): {
  changed: string[];
  deleted: string[];
} {
  const root = resolve(workspace);
  const probe = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || !probe.stdout.trim().includes('true')) {
    throw new Error(`Not a git repository: ${root}. Run full \`fastpath index\` instead.`);
  }

  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '-uall'], {
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    throw new Error(status.stderr || 'git status failed');
  }

  const ignore = new IgnoreMatcher(root);
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let pathPart = line.slice(3).trim();
    // renames: "R  old -> new"
    if (pathPart.includes(' -> ')) {
      pathPart = pathPart.split(' -> ').pop()!.trim();
    }
    // quoted paths
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.slice(1, -1).replace(/\\"/g, '"');
    }
    const rel = pathPart.split(sep).join('/');
    if (!rel || !isIndexableRel(rel)) continue;
    const abs = resolve(root, rel);
    if (ignore.ignores(root, abs)) continue;

    if (code.includes('D') && !existsSync(abs)) {
      deleted.push(rel);
      continue;
    }
    if (existsSync(abs)) changed.push(abs);
    else deleted.push(rel);
  }

  return {
    changed: [...new Set(changed)],
    deleted: [...new Set(deleted)],
  };
}

/** Index only git-changed files; remove deleted from index. */
export async function indexGitChanged(workspace: string): Promise<
  IndexResult & { removed: number }
> {
  const { changed, deleted } = listGitChangedFiles(workspace);
  const removed = removeIndexedPaths(workspace, deleted);
  if (!changed.length) {
    const stats = getIndexStats(workspace);
    return {
      stats,
      filesIndexed: 0,
      filesSkipped: 0,
      embedBackend: getEmbedBackend(),
      embedDim: getEmbedDim(),
      removed,
    };
  }
  const result = await indexWorkspacePaths(workspace, changed);
  return { ...result, removed };
}

export function readStats(
  db: Database.Database,
  workspace: string,
  dbPath: string,
): IndexStats {
  const files = (db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number }).c;
  const symbols = (db.prepare(`SELECT COUNT(*) AS c FROM symbols`).get() as { c: number }).c;
  const edges = (db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number }).c;
  return {
    workspace,
    dbPath,
    files,
    symbols,
    edges,
    indexedAt: getMeta(db, 'indexed_at'),
  };
}

export function getIndexStats(workspace: string): IndexStats {
  const dbPath = resolveDbPath(workspace);
  if (!existsSync(dbPath)) {
    return {
      workspace,
      dbPath,
      files: 0,
      symbols: 0,
      edges: 0,
      indexedAt: null,
    };
  }
  const db = openDatabase(dbPath, { create: false });
  try {
    return readStats(db, workspace, dbPath);
  } finally {
    db.close();
  }
}
