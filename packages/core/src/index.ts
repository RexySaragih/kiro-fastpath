export {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_KEEP_DIRS,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_TOP_K,
  HARD_MAX_CHUNKS,
  HARD_MAX_TOP_K,
  INDEXABLE_EXTENSIONS,
  SYMBOL_EXTENSIONS,
  TEXT_ONLY_EXTENSIONS,
  IndexLimits,
  InjectLimits,
  McpTimeouts,
  WindowLimits,
  type CallEdge,
  type ImportEdge,
  type IndexStats,
  type IndexedSymbol,
  type SearchHit,
  type SearchOptions,
  type SymbolKind,
} from './types.js';

export {
  enrichHitsWithWindows,
  readWindow,
  resolveWorkspacePath,
  computeWindowRange,
  isQualityHit,
  countQualityHits,
  type CodeWindow,
  type ReadWindowOptions,
} from './window.js';

export { IgnoreMatcher } from './ignore.js';
export { tokenizeIdentifier, clampTopK, snippetAround } from './tokenize.js';
export {
  openDatabase,
  getMeta,
  setMeta,
  getSchemaVersion,
  checkDatabaseIntegrity,
  CURRENT_SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
} from './db/schema.js';
export { parseFile, parseTypeScript, parsePython, parseGo } from './parse/extract.js';
export { parseFileAst, warmParsers } from './parse/treesitter.js';
export {
  indexWorkspace,
  indexWorkspacePaths,
  indexGitChanged,
  indexHeadChange,
  gitHeadSha,
  buildSymbolChunk,
  listGitChangedFiles,
  removeIndexedPaths,
  findDirtyFiles,
  walkIndexableFiles,
  getIndexStats,
  resolveDbPath,
  type IndexResult,
} from './index/indexer.js';
export {
  searchIndex,
  lookupSymbol,
  contextForTask,
  recentSymbols,
  listIndexedPaths,
  expandQueryTerms,
  zeroHitLadder,
} from './search/query.js';
export { grepFast } from './search/grep.js';
export { impactForSymbol, formatImpact, type ImpactResult } from './search/impact.js';
export { fuseRrf, classifyQuery, type QueryKind } from './search/rrf.js';
export { rerankHits, warmReranker, resetRerankerForTests, RERANK_MODEL } from './search/rerank.js';
export {
  embedText,
  cosine,
  EMBED_DIM,
  HASH_EMBED_DIM,
  vecToBlob,
  blobToVec,
} from './embed/hash.js';
export {
  embedQuery,
  embedMany,
  warmEmbedder,
  getEmbedBackend,
  getEmbedDim,
  resetEmbedderForTests,
  modelCacheDir,
  minilmWeightsPresent,
  MINILM_DIM,
  MINILM_MODEL,
  type EmbedBackendName,
} from './embed/backend.js';
export { buildAllNgrams, buildCovering, ngramHash } from './ngram/sparse.js';
export { watchWorkspace, type WatchOptions } from './watch/watcher.js';
export {
  saveMemory,
  recallMemories,
  listMemories,
  forgetMemory,
  distillMemories,
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryKind,
  type SaveMemoryInput,
} from './memory/store.js';
export {
  collectVizSnapshot,
  type VizSnapshot,
  type CountRow,
  type HeavyFile,
  type GraphNode,
  type GraphEdge,
} from './viz/snapshot.js';
export {
  tryEnableSqliteVec,
  sqliteVecAvailable,
  lshCandidateIds,
} from './search/ann.js';
export {
  CHARS_PER_TOKEN,
  FILE_COUNTERFACTUAL_CAP_TOKENS,
  WALK_ENTRY_CHARS,
  WALK_TOKENS_AVOIDED,
  estimateTokens,
  userFastpathDir,
  metricsPath,
  ledgerStatePath,
  LOG_MAX_BYTES,
  appendRotatingLine,
  appendMetric,
  readMetrics,
  resetLedgerState,
  claimPath,
  claimDiscovery,
  discoveryWalkTokens,
  cappedFileTokens,
  windowVsFileTokens,
  creditLocateHits,
  creditWindowRead,
  tokenLedger,
  type InjectMode,
  type MetricEvent,
  type LocateCredit,
  type TokenLedger,
} from './metrics/index.js';
