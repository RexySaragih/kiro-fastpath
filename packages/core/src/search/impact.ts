import { openDatabase } from '../db/schema.js';
import { resolveDbPath } from '../index/indexer.js';
import { clampTopK } from '../tokenize.js';
import { DEFAULT_TOP_K, HARD_MAX_TOP_K, type SearchHit } from '../types.js';

export interface ImpactResult {
  symbol: string;
  definitions: SearchHit[];
  importers: SearchHit[];
  callers: SearchHit[];
  references: SearchHit[];
}

export function impactForSymbol(
  workspace: string,
  name: string,
  options: { depth?: number; topK?: number } = {},
): ImpactResult {
  const topK = clampTopK(options.topK, DEFAULT_TOP_K, HARD_MAX_TOP_K);
  const depth = Math.min(3, Math.max(1, options.depth ?? 1));
  const db = openDatabase(resolveDbPath(workspace), { create: false });

  try {
    const definitions = (
      db
        .prepare(
          `SELECT path, name, kind, line, signature FROM symbols
           WHERE name = ? OR name LIKE ?
           ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END
           LIMIT ?`,
        )
        .all(name, `%.${name}`, name, topK) as Array<{
        path: string;
        name: string;
        kind: string;
        line: number;
        signature: string;
      }>
    ).map((r, i) => ({
      path: r.path,
      symbol: r.name,
      kind: r.kind,
      line: r.line,
      score: topK - i,
      snippet: r.signature,
    }));

    const defPaths = new Set(definitions.map((d) => d.path));
    const importers: SearchHit[] = [];
    let frontier = [...defPaths];

    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const path of frontier) {
        const rows = db
          .prepare(
            `SELECT DISTINCT from_path, to_specifier FROM edges
             WHERE to_path = ? OR to_specifier LIKE ?`,
          )
          .all(path, `%${name}%`) as Array<{
          from_path: string;
          to_specifier: string;
        }>;
        for (const row of rows) {
          if (defPaths.has(row.from_path)) continue;
          importers.push({
            path: row.from_path,
            symbol: null,
            kind: 'importer',
            line: null,
            score: depth - d,
            snippet: `imports ${row.to_specifier}`,
          });
          next.push(row.from_path);
        }
      }
      frontier = next;
    }

    const callers = (
      db
        .prepare(
          `SELECT from_path, from_symbol, to_name, line, kind
           FROM call_edges
           WHERE to_name = ? OR to_name LIKE ?
           ORDER BY CASE WHEN to_name = ? THEN 0 ELSE 1 END, line
           LIMIT ?`,
        )
        .all(name, `%.${name}`, name, topK * 2) as Array<{
        from_path: string;
        from_symbol: string | null;
        to_name: string;
        line: number;
        kind: string;
      }>
    )
      .filter((r) => !defPaths.has(r.from_path))
      .map((r, i) => ({
        path: r.from_path,
        symbol: r.from_symbol,
        kind: 'caller',
        line: r.line,
        score: topK - i,
        snippet: `${r.from_symbol ?? r.from_path} → ${r.to_name}`,
      }));

    let references: SearchHit[] = [];
    try {
      const ftsQ = `"${name.replace(/"/g, '')}"`;
      const callerPaths = new Set(callers.map((c) => c.path));
      references = (
        db
          .prepare(
            `SELECT path, snippet(files_fts, 1, '', '', '…', 10) AS snip
             FROM files_fts WHERE files_fts MATCH ? LIMIT ?`,
          )
          .all(ftsQ, topK) as Array<{ path: string; snip: string }>
      )
        .filter((r) => !defPaths.has(r.path) && !callerPaths.has(r.path))
        .map((r, i) => ({
          path: r.path,
          symbol: name,
          kind: 'reference',
          line: null,
          score: topK - i,
          snippet: r.snip,
        }));
    } catch {
      references = [];
    }

    return {
      symbol: name,
      definitions,
      importers: dedupeHits(importers).slice(0, topK),
      callers: dedupeHits(callers).slice(0, topK),
      references: dedupeHits(references).slice(0, topK),
    };
  } finally {
    db.close();
  }
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = `${h.path}:${h.kind}:${h.line}:${h.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function formatImpact(result: ImpactResult): string {
  const lines = [`## impact: ${result.symbol}`, '', '### definitions'];
  if (!result.definitions.length) lines.push('(none)');
  for (const h of result.definitions) {
    lines.push(`- **${h.symbol}** (${h.kind}) — \`${h.path}:${h.line}\``);
    if (h.snippet) lines.push('```', h.snippet, '```');
  }
  lines.push('', '### callers');
  if (!result.callers.length) lines.push('(none)');
  for (const h of result.callers) {
    const loc = h.line ? `${h.path}:${h.line}` : h.path;
    lines.push(`- \`${loc}\` — ${h.snippet}`);
  }
  lines.push('', '### importers');
  if (!result.importers.length) lines.push('(none)');
  for (const h of result.importers) {
    lines.push(`- \`${h.path}\` — ${h.snippet}`);
  }
  lines.push('', '### references');
  if (!result.references.length) lines.push('(none)');
  for (const h of result.references) {
    lines.push(`- \`${h.path}\``);
    if (h.snippet) lines.push('```', h.snippet, '```');
  }
  return lines.join('\n');
}
