export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'const'
  | 'variable'
  | 'export'
  | 'other';

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  endLine: number;
  signature: string;
  tokens: string;
}

export interface ImportEdge {
  fromPath: string;
  toPath: string;
  toSpecifier: string;
}

export interface CallEdge {
  fromPath: string;
  fromSymbol: string | null;
  toName: string;
  toPath: string | null;
  line: number;
  kind: 'call' | 'ref';
}

export interface SearchHit {
  path: string;
  symbol: string | null;
  kind: string | null;
  line: number | null;
  score: number;
  snippet: string;
}

export interface IndexStats {
  workspace: string;
  dbPath: string;
  files: number;
  symbols: number;
  edges: number;
  indexedAt: string | null;
}

export interface SearchOptions {
  topK?: number;
  pathPrefix?: string;
}

export const DEFAULT_TOP_K = 8;
export const HARD_MAX_TOP_K = 20;
export const DEFAULT_MAX_CHUNKS = 5;
export const HARD_MAX_CHUNKS = 8;

/** Indexer / search resource caps (named — no magic numbers in hot paths). */
export const IndexLimits = {
  MAX_FILE_BYTES: 1_500_000,
  NGRAM_CONTENT_BYTES: 80_000,
  MAX_NGRAMS_PER_FILE: 20_000,
  FILE_FTS_BODY_BYTES: 200_000,
  VECTOR_SCAN_LIMIT: 5_000,
  COSINE_MIN_SCORE: 0.05,
  RRF_K: 60,
  GREP_FALLBACK_FILE_LIMIT: 500,
  MAX_GREP_LITERALS: 4,
  MAX_COVERING_NGRAMS: 8,
  DELTA_MAX_FILES: 20,
  RERANK_CANDIDATES: 20,
  INJECT_DELTA_BUDGET_MS: 2000,
  INJECT_RETRIEVE_BUDGET_MS: 3000,
  /** Doctor warns when indexed file count exceeds this (tune via FASTPATH_WARN_FILES). */
  WARN_FILE_COUNT: 50_000,
  /** Doctor/metrics: inject hit-rate below this (0–1) after enough samples. */
  INJECT_HIT_RATE_FLOOR: 0.25,
  INJECT_HIT_RATE_MIN_SAMPLES: 10,
} as const;

/** MCP stdio timeouts written into agent/mcp.json (Kiro defaults are lower for cold MiniLM). */
export const McpTimeouts = {
  CONNECT_MS: 60_000,
  REQUEST_MS: 180_000,
} as const;

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.yarn',
  '.nx',
  '.fastpath',
  '.kiro',
  '__pycache__',
  'vendor',
  'target',
  '.venv',
  'venv',
]);

export const INDEXABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
]);
