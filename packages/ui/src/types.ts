export type ScreenId = 'setup' | 'repos' | 'health' | 'signal';

export interface FastpathConfig {
  home: string;
  version: string;
  workspaces: Record<string, { wiredAt: string }>;
  lastWorkspace: string | null;
}

export interface StatePayload {
  version: string;
  home: string;
  defaultHome?: string;
  checkout?: string;
  installed?: boolean;
  cli: string;
  wired: string[];
  config: FastpathConfig;
}

export interface IndexStats {
  workspace: string;
  dbPath: string;
  files: number;
  symbols: number;
  edges: number;
  indexedAt: string | null;
}

export interface HookLiveness {
  verified: boolean;
  fired: string[];
  never: string[];
  stale: string[];
}

export interface DoctorResult {
  ready: boolean;
  issues: string[];
  ok: string[];
  notes: string[];
  stats: IndexStats;
  embedBackend: string;
  agentsIdeCompatible: boolean;
  hookEnabled: boolean;
  schemaVersion: number;
  integrityOk: boolean | null;
  searchSmokeOk: boolean | null;
  hookLiveness: HookLiveness;
  version: string;
  home: string;
  workspace: string;
}

export interface CountRow {
  label: string;
  count: number;
}

export interface VizMetricsSummary {
  events: number;
  injects: number;
  retrievalInjects: number;
  hitRate: number | null;
  codeHitRate: number | null;
  p50DeltaMs: number | null;
  timeouts: number;
  indexes: number;
  doctors: number;
  injectedTokens: number | null;
  mcpResponseTokens: number | null;
  tokensAvoided: number | null;
  avoidedBlockedWalk: number | null;
  avoidedWindowVsFile: number | null;
  avoidedDiscovery: number | null;
  spentTokens: number | null;
  netTokens: number | null;
  mcpCalls: number;
  mcpOk: number;
  walksSeen: number;
  walksBlocked: number;
  insight: string;
}

export interface WorkspaceUsageRow {
  workspace: string;
  injects: number;
  mcpCalls: number;
  spentTokens: number | null;
  netTokens: number | null;
}

export interface VizPageData {
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
  heavyFiles: Array<{ path: string; symbols: number; language: string }>;
  projectMetrics: VizMetricsSummary;
  globalMetrics: VizMetricsSummary;
  workspaces: WorkspaceUsageRow[];
  untaggedEvents: number;
  eventMix: CountRow[];
  generatedAt: string;
}

export type JobVerb =
  | 'index'
  | 'watch'
  | 'warm'
  | 'doctor'
  | 'use'
  | 'install-kiro'
  | 'repair-kiro'
  | 'rewire'
  | 'unwire'
  | 'upgrade'
  | 'repair-native'
  | 'memory-distill'
  | 'install-home';

export interface JobSpec {
  verb: JobVerb;
  workspace?: string;
  flags?: string[];
  from?: string;
  confirm?: string;
}

export interface JobLine {
  stream?: 'stdout' | 'stderr';
  line?: string;
  exit?: number | null;
}

export interface ActiveJob {
  id: string;
  verb: JobVerb;
  workspace?: string;
  running: boolean;
  lines: Array<{ stream: 'stdout' | 'stderr'; line: string }>;
  exitCode: number | null;
}
