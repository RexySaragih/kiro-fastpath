/**
 * Focused code windows for MCP / inject — path + line range + body so agents
 * can edit without whole-file host reads.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './db/schema.js';
import { IgnoreMatcher } from './ignore.js';
import { resolveDbPath } from './index/indexer.js';
import { INDEXABLE_EXTENSIONS, type SearchHit, WindowLimits } from './types.js';

export interface CodeWindow {
  path: string;
  startLine: number;
  endLine: number;
  body: string;
  /** True when the requested range was clamped to file/caps. */
  clamped: boolean;
}

export interface ReadWindowOptions {
  /** When true, prefix each line with `N| `. Default false for MCP windows. */
  numberLines?: boolean;
}

function withWorkspaceDb<T>(workspace: string, fn: (db: Database.Database) => T): T {
  const db = openDatabase(resolveDbPath(workspace), { create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Resolve a workspace-relative path; reject escapes. */
export function resolveWorkspacePath(workspace: string, relPath: string): string | null {
  const clean = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.includes('\0')) return null;
  if (isAbsolute(clean)) return null;
  const abs = normalize(join(workspace, clean));
  const root = normalize(workspace);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return abs;
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function clampRange(
  startLine: number,
  endLine: number,
  fileLineCount: number,
): { start: number; end: number; clamped: boolean } {
  let start = Math.max(1, Math.floor(startLine));
  let end = Math.max(start, Math.floor(endLine));
  let clamped = false;

  if (start > fileLineCount) {
    start = Math.max(1, fileLineCount);
    clamped = true;
  }
  if (end > fileLineCount) {
    end = fileLineCount;
    clamped = true;
  }

  if (end - start + 1 > WindowLimits.MAX_LINES) {
    end = start + WindowLimits.MAX_LINES - 1;
    clamped = true;
  }

  return { start, end, clamped };
}

function sliceBody(
  lines: string[],
  start: number,
  end: number,
  numberLines: boolean,
): string {
  const slice = lines.slice(start - 1, end);
  let body = numberLines
    ? slice.map((l, i) => `${start + i}| ${l}`).join('\n')
    : slice.join('\n');
  if (body.length > WindowLimits.MAX_CHARS) {
    body = body.slice(0, WindowLimits.MAX_CHARS);
  }
  return body;
}

/**
 * Read a line-range window from a workspace file. Rejects path escape,
 * ignored paths, oversized files, and non-indexable extensions.
 */
export function readWindow(
  workspace: string,
  relPath: string,
  startLine: number,
  endLine: number,
  options: ReadWindowOptions = {},
): CodeWindow {
  const abs = resolveWorkspacePath(workspace, relPath);
  if (!abs) {
    throw new Error(`Invalid path (escape rejected): ${relPath}`);
  }
  const rel = relative(workspace, abs).split(sep).join('/');
  if (!INDEXABLE_EXTENSIONS.has(extOf(rel))) {
    throw new Error(`Unsupported extension for window: ${rel}`);
  }
  const ignore = new IgnoreMatcher(workspace);
  if (ignore.ignores(workspace, abs)) {
    throw new Error(`Path is ignored: ${rel}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${rel}`);
  }
  const st = statSync(abs);
  if (!st.isFile() || st.size > WindowLimits.MAX_FILE_BYTES) {
    throw new Error(`File unreadable or too large: ${rel}`);
  }

  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  const { start, end, clamped } = clampRange(startLine, endLine, lines.length);
  const body = sliceBody(lines, start, end, options.numberLines === true);

  return {
    path: rel,
    startLine: start,
    endLine: end,
    body,
    clamped,
  };
}

interface SpanRow {
  start: number;
  end: number;
}

/** Look up AST chunk / symbol end spans for hits that have a line anchor. */
function lookupSpans(
  db: Database.Database,
  hits: SearchHit[],
): Map<string, SpanRow> {
  const spans = new Map<string, SpanRow>();
  const chunkAt = db.prepare(
    `SELECT start_line, end_line FROM chunks WHERE path = ? AND start_line = ?`,
  );
  const chunkCovering = db.prepare(
    `SELECT start_line, end_line FROM chunks
     WHERE path = ? AND start_line <= ? AND end_line >= ?
     ORDER BY (end_line - start_line) ASC
     LIMIT 1`,
  );
  const symbolEnd = db.prepare(
    `SELECT line, end_line FROM symbols WHERE path = ? AND line = ? LIMIT 1`,
  );

  for (const hit of hits) {
    if (!hit.line) continue;
    const key = `${hit.path}:${hit.line}`;
    if (spans.has(key)) continue;

    const at = chunkAt.get(hit.path, hit.line) as
      | { start_line: number; end_line: number }
      | undefined;
    if (at) {
      spans.set(key, { start: at.start_line, end: at.end_line });
      continue;
    }
    const covering = chunkCovering.get(hit.path, hit.line, hit.line) as
      | { start_line: number; end_line: number }
      | undefined;
    if (covering) {
      spans.set(key, { start: covering.start_line, end: covering.end_line });
      continue;
    }
    const sym = symbolEnd.get(hit.path, hit.line) as
      | { line: number; end_line: number }
      | undefined;
    if (sym) {
      spans.set(key, { start: sym.line, end: Math.max(sym.end_line, sym.line) });
    }
  }
  return spans;
}

/**
 * Compute a display window around an anchor line, preferring full AST span
 * when it fits under MAX_LINES; otherwise a centered pad window.
 */
export function computeWindowRange(
  anchorLine: number,
  span: SpanRow | undefined,
  fileLineCount: number,
): { start: number; end: number } {
  if (span) {
    const spanLines = span.end - span.start + 1;
    if (spanLines <= WindowLimits.MAX_LINES) {
      return clampRange(span.start, span.end, fileLineCount);
    }
    // Oversized symbol: center on the anchor inside the span.
    const half = Math.floor(WindowLimits.MAX_LINES / 2);
    const start = Math.max(span.start, anchorLine - half);
    return clampRange(start, start + WindowLimits.MAX_LINES - 1, fileLineCount);
  }
  const pad = WindowLimits.DEFAULT_PAD;
  return clampRange(anchorLine - pad, anchorLine + pad, fileLineCount);
}

/**
 * Enrich search hits with focused file windows (startLine/endLine + body).
 * Hits without a readable line keep their prior snippet.
 */
export function enrichHitsWithWindows(
  workspace: string,
  hits: SearchHit[],
): SearchHit[] {
  if (!hits.length) return hits;

  let spans = new Map<string, SpanRow>();
  try {
    spans = withWorkspaceDb(workspace, (db) => lookupSpans(db, hits));
  } catch {
    spans = new Map();
  }

  const contentCache = new Map<string, string[]>();

  return hits.map((hit) => {
    if (!hit.line) return hit;
    const abs = resolveWorkspacePath(workspace, hit.path);
    if (!abs || !existsSync(abs)) return hit;

    try {
      let lines = contentCache.get(hit.path);
      if (!lines) {
        lines = readFileSync(abs, 'utf8').split('\n');
        contentCache.set(hit.path, lines);
      }
      const span = spans.get(`${hit.path}:${hit.line}`);
      const range = computeWindowRange(hit.line, span, lines.length);
      let body = sliceBody(lines, range.start, range.end, false);
      if (!body.trim()) return hit;
      return {
        ...hit,
        startLine: range.start,
        endLine: range.end,
        snippet: body,
      };
    } catch {
      return hit;
    }
  });
}

/**
 * A "quality" hit has a usable body window — used for inject metrics / doctor.
 * Score floor filters near-noise vector crumbs when present.
 */
export function isQualityHit(hit: SearchHit, scoreFloor = 0): boolean {
  if (!hit.snippet || !hit.snippet.trim()) return false;
  if (hit.startLine == null || hit.endLine == null) return false;
  if (hit.snippet.trim().length < WindowLimits.MIN_QUALITY_CHARS) return false;
  if (scoreFloor > 0 && hit.score < scoreFloor) return false;
  return true;
}

export function countQualityHits(hits: SearchHit[], scoreFloor = 0): number {
  return hits.filter((h) => isQualityHit(h, scoreFloor)).length;
}
