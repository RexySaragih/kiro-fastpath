/**
 * Read-only index snapshot for `fastpath viz`.
 * Caps keep large repos (10k+ call edges) renderable in a static HTML page.
 */
import { existsSync } from 'node:fs';
import { openDatabase, getMeta } from '../db/schema.js';
import { resolveDbPath } from '../index/indexer.js';
import type { MemoryEntry, MemoryKind } from '../memory/store.js';

const TOP_FOLDERS = 20;
const TOP_HEAVY_FILES = 15;
const GRAPH_NODES = 48;
const GRAPH_EDGES = 90;
const MEMORY_LIMIT = 50;

/** Noise callees that dominate call graphs but add little project insight. */
const NOISE_CALLEE =
  /^(expect|jest|describe|it|test|beforeEach|afterEach|console|JSON|Buffer|Math|Object|Array|Promise|Error|Map|Set|Date|Number|String|Boolean|RegExp|parseInt|parseFloat|require|import|logger|debug|info|warn|error|log)$/i;
const NOISE_PREFIX =
  /^(expect\.|jest\.|console\.|logger\.|JSON\.|Buffer\.|Math\.|Object\.|Array\.|Promise\.|fs\.|path\.|process\.)/;

function isUsefulCallee(name: string): boolean {
  const n = name.trim();
  if (!n || n === '(anon)' || n.length < 2) return false;
  if (NOISE_CALLEE.test(n) || NOISE_PREFIX.test(n)) return false;
  if (
    /^(Get|Post|Put|Patch|Delete|Body|Query|Param|Inject|Injectable|Module|Controller|Column|Entity)$/.test(
      n,
    )
  ) {
    return false;
  }
  return true;
}

export interface CountRow {
  label: string;
  count: number;
}

export interface HeavyFile {
  path: string;
  symbols: number;
  language: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: 'symbol' | 'file';
  degree: number;
  /** Symbol kind from index (function, class, …) when known. */
  symbolKind?: string;
  signature?: string;
  line?: number;
  paths: string[];
  callers: number;
  callees: number;
  topCallers: string[];
  topCallees: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
}

export interface VizSnapshot {
  workspace: string;
  dbPath: string;
  indexedAt: string | null;
  embedBackend: string | null;
  schemaVersion: string | null;
  annBackend: string | null;
  summary: {
    files: number;
    symbols: number;
    importEdges: number;
    callEdges: number;
    memories: number;
    vectors: number;
    ngrams: number;
  };
  folders: CountRow[];
  languages: CountRow[];
  symbolKinds: CountRow[];
  heavyFiles: HeavyFile[];
  callGraph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  memories: MemoryEntry[];
}

function folderOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  if (parts[0] === 'src' || parts[0] === 'packages' || parts[0] === 'apps') {
    return parts.slice(0, Math.min(2, parts.length)).join('/');
  }
  return parts[0]!;
}

export function collectVizSnapshot(workspace: string): VizSnapshot {
  const dbPath = resolveDbPath(workspace);
  if (!existsSync(dbPath)) {
    throw new Error(`FastPath index not found at ${dbPath}. Run: fastpath index`);
  }

  const db = openDatabase(dbPath, { create: false });
  try {
    const count = (sql: string): number =>
      (db.prepare(sql).get() as { c: number }).c;

    const files = count(`SELECT COUNT(*) AS c FROM files`);
    const symbols = count(`SELECT COUNT(*) AS c FROM symbols`);
    const importEdges = count(`SELECT COUNT(*) AS c FROM edges`);
    const callEdges = count(`SELECT COUNT(*) AS c FROM call_edges`);
    const memoriesCount = count(`SELECT COUNT(*) AS c FROM memories`);
    const vectors = count(`SELECT COUNT(*) AS c FROM symbol_vectors`);
    const ngrams = count(`SELECT COUNT(*) AS c FROM ngrams`);

    const fileRows = db.prepare(`SELECT path, language FROM files`).all() as Array<{
      path: string;
      language: string;
    }>;

    const folderMap = new Map<string, number>();
    const langMap = new Map<string, number>();
    for (const row of fileRows) {
      const folder = folderOf(row.path);
      folderMap.set(folder, (folderMap.get(folder) ?? 0) + 1);
      const lang = row.language || 'unknown';
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }

    const folders = [...folderMap.entries()]
      .map(([label, c]) => ({ label, count: c }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_FOLDERS);

    const languages = [...langMap.entries()]
      .map(([label, c]) => ({ label, count: c }))
      .sort((a, b) => b.count - a.count);

    const symbolKinds = (
      db
        .prepare(
          `SELECT kind AS label, COUNT(*) AS count FROM symbols GROUP BY kind ORDER BY count DESC`,
        )
        .all() as CountRow[]
    ).map((r) => ({ label: r.label || 'other', count: Number(r.count) }));

    const heavyFiles = (
      db
        .prepare(
          `SELECT s.path AS path, COUNT(*) AS symbols, COALESCE(f.language, '') AS language
           FROM symbols s
           LEFT JOIN files f ON f.path = s.path
           GROUP BY s.path
           ORDER BY symbols DESC
           LIMIT ?`,
        )
        .all(TOP_HEAVY_FILES) as HeavyFile[]
    ).map((r) => ({
      path: r.path,
      symbols: Number(r.symbols),
      language: r.language || 'unknown',
    }));

    const callGraph = buildCallGraphSample(db);

    const memoryRows = db
      .prepare(
        `SELECT id, kind, text, tags, paths, created_at, last_used_at, use_count
         FROM memories ORDER BY id DESC LIMIT ?`,
      )
      .all(MEMORY_LIMIT) as Array<{
      id: number;
      kind: string;
      text: string;
      tags: string;
      paths: string;
      created_at: string;
      last_used_at: string | null;
      use_count: number;
    }>;

    const memories: MemoryEntry[] = memoryRows.map((r) => ({
      id: r.id,
      kind: r.kind as MemoryKind,
      text: r.text,
      tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
      paths: r.paths ? r.paths.split(',').filter(Boolean) : [],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
    }));

    return {
      workspace,
      dbPath,
      indexedAt: getMeta(db, 'indexed_at'),
      embedBackend: getMeta(db, 'embed_backend'),
      schemaVersion: getMeta(db, 'schema_version'),
      annBackend: getMeta(db, 'ann_backend'),
      summary: {
        files,
        symbols,
        importEdges,
        callEdges,
        memories: memoriesCount,
        vectors,
        ngrams,
      },
      folders,
      languages,
      symbolKinds,
      heavyFiles,
      callGraph,
      memories,
    };
  } finally {
    db.close();
  }
}

function emptyNodeMeta(name: string, degree: number): GraphNode {
  return {
    id: name,
    label: name,
    kind: 'symbol',
    degree,
    paths: [],
    callers: 0,
    callees: 0,
    topCallers: [],
    topCallees: [],
  };
}

function enrichGraphNodes(
  db: import('better-sqlite3').Database,
  nodes: GraphNode[],
): GraphNode[] {
  if (!nodes.length) return nodes;
  const names = nodes.map((n) => n.id);
  const placeholders = names.map(() => '?').join(',');

  const symbolRows = db
    .prepare(
      `SELECT name, kind, path, line, signature
       FROM symbols
       WHERE name IN (${placeholders})
       ORDER BY path, line`,
    )
    .all(...names) as Array<{
    name: string;
    kind: string;
    path: string;
    line: number;
    signature: string;
  }>;

  const byName = new Map<string, GraphNode>();
  for (const n of nodes) byName.set(n.id, { ...n });

  for (const row of symbolRows) {
    const node = byName.get(row.name);
    if (!node) continue;
    if (!node.symbolKind) node.symbolKind = row.kind || undefined;
    if (!node.signature && row.signature) node.signature = row.signature.slice(0, 160);
    if (node.line == null && row.line != null) node.line = Number(row.line);
    if (row.path && node.paths.length < 6 && !node.paths.includes(row.path)) {
      node.paths.push(row.path);
    }
  }

  const callerRows = db
    .prepare(
      `SELECT to_name AS name, from_symbol AS peer, COUNT(*) AS w
       FROM call_edges
       WHERE to_name IN (${placeholders})
         AND from_symbol IS NOT NULL AND from_symbol != ''
       GROUP BY to_name, from_symbol
       ORDER BY w DESC`,
    )
    .all(...names) as Array<{ name: string; peer: string; w: number }>;

  const calleeRows = db
    .prepare(
      `SELECT from_symbol AS name, to_name AS peer, COUNT(*) AS w
       FROM call_edges
       WHERE from_symbol IN (${placeholders})
         AND to_name IS NOT NULL AND to_name != ''
       GROUP BY from_symbol, to_name
       ORDER BY w DESC`,
    )
    .all(...names) as Array<{ name: string; peer: string; w: number }>;

  const pathAsCallee = db
    .prepare(
      `SELECT to_name AS name, to_path AS path
       FROM call_edges
       WHERE to_name IN (${placeholders}) AND to_path IS NOT NULL AND to_path != ''
       GROUP BY to_name, to_path`,
    )
    .all(...names) as Array<{ name: string; path: string }>;

  for (const row of pathAsCallee) {
    const node = byName.get(row.name);
    if (!node || !row.path) continue;
    if (node.paths.length < 6 && !node.paths.includes(row.path)) node.paths.push(row.path);
  }

  const callerCounts = new Map<string, number>();
  for (const row of callerRows) {
    const node = byName.get(row.name);
    if (!node || !isUsefulCallee(row.peer)) continue;
    callerCounts.set(row.name, (callerCounts.get(row.name) ?? 0) + Number(row.w));
    if (node.topCallers.length < 8) node.topCallers.push(row.peer);
  }
  const calleeCounts = new Map<string, number>();
  for (const row of calleeRows) {
    const node = byName.get(row.name);
    if (!node || !isUsefulCallee(row.peer)) continue;
    calleeCounts.set(row.name, (calleeCounts.get(row.name) ?? 0) + Number(row.w));
    if (node.topCallees.length < 8) node.topCallees.push(row.peer);
  }

  return nodes.map((n) => {
    const enriched = byName.get(n.id)!;
    return {
      ...enriched,
      callers: callerCounts.get(n.id) ?? enriched.degree,
      callees: calleeCounts.get(n.id) ?? 0,
    };
  });
}

function buildCallGraphSample(db: import('better-sqlite3').Database): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const candidates = db
    .prepare(
      `SELECT to_name AS name, COUNT(*) AS degree
       FROM call_edges
       WHERE to_name IS NOT NULL AND to_name != ''
       GROUP BY to_name
       ORDER BY degree DESC
       LIMIT ?`,
    )
    .all(GRAPH_NODES * 6) as Array<{ name: string; degree: number }>;

  const topTargets = candidates.filter((t) => isUsefulCallee(t.name)).slice(0, GRAPH_NODES);
  if (!topTargets.length) return { nodes: [], edges: [] };

  const nodeIds = new Set(topTargets.map((t) => t.name));
  let nodes: GraphNode[] = topTargets.map((t) =>
    emptyNodeMeta(t.name, Number(t.degree)),
  );

  const edgeRows = db
    .prepare(
      `SELECT from_symbol, to_name, COUNT(*) AS weight
       FROM call_edges
       WHERE to_name IN (${[...nodeIds].map(() => '?').join(',')})
       GROUP BY from_symbol, to_name
       ORDER BY weight DESC
       LIMIT ?`,
    )
    .all(...nodeIds, GRAPH_EDGES * 3) as Array<{
    from_symbol: string | null;
    to_name: string;
    weight: number;
  }>;

  const edges: GraphEdge[] = [];
  for (const row of edgeRows) {
    const fromRaw = row.from_symbol?.trim() || '';
    if (!fromRaw || !isUsefulCallee(fromRaw)) continue;
    if (!nodeIds.has(fromRaw)) {
      if (nodes.length >= GRAPH_NODES + 24) continue;
      nodeIds.add(fromRaw);
      nodes.push(emptyNodeMeta(fromRaw, 1));
    }
    edges.push({
      from: fromRaw,
      to: row.to_name,
      weight: Number(row.weight),
    });
    if (edges.length >= GRAPH_EDGES) break;
  }

  nodes = enrichGraphNodes(db, nodes);
  return { nodes, edges };
}
