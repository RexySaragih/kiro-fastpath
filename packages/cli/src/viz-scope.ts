/**
 * Dual-scope viz metrics: this workspace vs all-machine journal.
 * Strict path match — no untagged/all-inject fallback.
 */
import { resolve } from 'node:path';
import {
  readMetrics,
  tokenLedger,
  type MetricEvent,
  type CountRow,
} from '@fastpath/core';

export const UNTAGGED_WORKSPACE = '(untagged)';

const KNOWN_EVENT_TYPES = new Set([
  'inject',
  'mcp',
  'guardrail',
  'index',
  'doctor',
]);

export type HealthKind = 'ok' | 'warn' | 'bad';

export interface VizMetricsSummary {
  events: number;
  injects: number;
  /** Injects that attempted retrieval (excludes noPrompt housekeeping). */
  retrievalInjects: number;
  hitRate: number | null;
  /** Hit rate among injects with intent === 'code'. Null when none tagged. */
  codeHitRate: number | null;
  p50DeltaMs: number | null;
  timeouts: number;
  indexes: number;
  doctors: number;
  /** Measured: ceil(chars/4) of inject STDOUT. Null when no inject samples. */
  injectedTokens: number | null;
  /** Measured: MCP tool response tokens. Null when no mcp samples. */
  mcpResponseTokens: number | null;
  /** Sum of estimated avoid buckets. Null when no avoid-side samples. */
  tokensAvoided: number | null;
  avoidedBlockedWalk: number | null;
  avoidedWindowVsFile: number | null;
  avoidedDiscovery: number | null;
  spentTokens: number | null;
  /** avoided − spent (mixed honesty). Null when no spend/avoid samples. */
  netTokens: number | null;
  mcpCalls: number;
  mcpOk: number;
  walksSeen: number;
  walksBlocked: number;
  /** Short operational insight for the token panel. */
  insight: string;
}

export interface WorkspaceUsageRow {
  workspace: string;
  injects: number;
  mcpCalls: number;
  spentTokens: number | null;
  netTokens: number | null;
}

export interface DualMetrics {
  projectMetrics: VizMetricsSummary;
  globalMetrics: VizMetricsSummary;
  workspaces: WorkspaceUsageRow[];
  untaggedEvents: number;
  eventMix: CountRow[];
}

export function normalizeWorkspace(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
}

export function sameWorkspace(a: string, b: string): boolean {
  const na = normalizeWorkspace(a);
  const nb = normalizeWorkspace(b);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** Test/ephemeral dirs that should not clutter the workspace table. */
export function isEphemeralWorkspace(p: string): boolean {
  if (p === UNTAGGED_WORKSPACE) return false;
  const n = p.replace(/\\/g, '/');
  return n.includes('/var/folders/') || n.includes('/tmp/');
}

export function healthClass(
  metric: 'hitRate' | 'net' | 'timeouts' | 'coverage' | 'mcpOk',
  value: number | null,
): HealthKind | null {
  if (value == null || Number.isNaN(value)) return null;
  switch (metric) {
    case 'hitRate':
      if (value >= 0.5) return 'ok';
      if (value >= 0.25) return 'warn';
      return 'bad';
    case 'net':
      if (value > 0) return 'ok';
      if (value === 0) return 'warn';
      return 'bad';
    case 'timeouts':
      if (value === 0) return 'ok';
      if (value <= 3) return 'warn';
      return 'bad';
    case 'coverage':
      if (value >= 0.8) return 'ok';
      if (value >= 0.5) return 'warn';
      return 'bad';
    case 'mcpOk':
      if (value >= 0.95) return 'ok';
      if (value >= 0.8) return 'warn';
      return 'bad';
  }
}

export function usageAdvice(
  m: VizMetricsSummary,
  opts: { workspace?: string; coveragePct?: number | null } = {},
): string[] {
  const ws = opts.workspace ? ` ${opts.workspace}` : '';
  if (m.events === 0) {
    return [`Run: fastpath use${ws} and start a Kiro session`];
  }
  const lines: string[] = [];
  if (m.retrievalInjects > 0 && m.hitRate != null && m.hitRate < 0.25) {
    lines.push(`Run: fastpath index${ws}`);
  }
  if (m.mcpCalls === 0) {
    lines.push('Agent not using MCP tools. Spawn Scout to gather, or call find/window.');
  }
  if (m.netTokens != null && m.netTokens < 0) {
    lines.push('Prefer MCP find/window over host file reads.');
  }
  if (opts.coveragePct === 0) {
    lines.push('Run: fastpath warm && fastpath index --rebuild');
  }
  if (m.timeouts > 0) {
    lines.push('Consider: fastpath watch for live reindexing');
  }
  return lines;
}

export function filterProjectEvents(
  events: MetricEvent[],
  workspace: string,
): MetricEvent[] {
  return events.filter(
    (e) => Boolean(e.workspace) && sameWorkspace(e.workspace!, workspace),
  );
}

function ledgerInsight(args: {
  injects: number;
  mcpCalls: number;
  mcpOk: number;
  tokensAvoided: number;
  spentTokens: number;
  hasSamples: boolean;
}): string {
  if (!args.hasSamples) {
    return 'No token samples yet — run a Kiro session with inject/MCP.';
  }
  if (args.mcpOk > 0 && args.tokensAvoided > 0) {
    return 'MCP path credited — Avoided ≈ includes window/discover estimates.';
  }
  if (args.mcpCalls === 0 && args.tokensAvoided === 0 && args.injects > 0) {
    return 'No MCP/walk credits yet — host walks or MCP calls drive Avoided ≈.';
  }
  if (args.tokensAvoided > 0 && args.tokensAvoided < args.spentTokens) {
    return 'Net ≈ negative — spent exceeds estimated avoid; check components.';
  }
  if (args.tokensAvoided > args.spentTokens) {
    return 'Net ≈ positive — estimated avoid exceeds measured spend.';
  }
  return 'Ledger mixes measured spend with estimated avoid buckets.';
}

export function summarizeEvents(events: MetricEvent[]): VizMetricsSummary {
  const injects = events.filter(
    (e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject',
  );
  const retrievalInjects = injects.filter((i) => !i.noPrompt);
  const indexes = events.filter((e) => e.type === 'index').length;
  const doctors = events.filter((e) => e.type === 'doctor').length;

  let hitRate: number | null = null;
  let codeHitRate: number | null = null;
  let p50DeltaMs: number | null = null;
  let timeouts = 0;
  if (injects.length) {
    hitRate = retrievalInjects.length
      ? retrievalInjects.filter((i) => i.hits > 0).length / retrievalInjects.length
      : null;
    const codeInjects = injects.filter((i) => i.intent === 'code');
    codeHitRate = codeInjects.length
      ? codeInjects.filter((i) => i.hits > 0).length / codeInjects.length
      : null;
    const deltas = [...injects.map((i) => i.deltaMs)].sort((a, b) => a - b);
    p50DeltaMs = deltas[Math.floor(deltas.length / 2)] ?? 0;
    timeouts = injects.filter((i) => i.timedOutDelta || i.timedOutRetrieve).length;
  }

  const ledger = tokenLedger(events);
  const hasTokenSamples = ledger.injects > 0 || ledger.mcpCalls > 0 || ledger.walksSeen > 0;
  const hasSamples = events.length > 0;

  return {
    events: events.length,
    injects: injects.length,
    retrievalInjects: retrievalInjects.length,
    hitRate,
    codeHitRate,
    p50DeltaMs,
    timeouts,
    indexes,
    doctors,
    injectedTokens: hasSamples ? ledger.injectedTokens : null,
    mcpResponseTokens: hasSamples ? ledger.mcpResponseTokens : null,
    tokensAvoided: hasSamples ? ledger.tokensAvoided : null,
    avoidedBlockedWalk: hasSamples ? ledger.avoidedBlockedWalk : null,
    avoidedWindowVsFile: hasSamples ? ledger.avoidedWindowVsFile : null,
    avoidedDiscovery: hasSamples ? ledger.avoidedDiscovery : null,
    spentTokens: hasSamples ? ledger.spentTokens : null,
    netTokens: hasSamples ? ledger.net : null,
    mcpCalls: ledger.mcpCalls,
    mcpOk: ledger.mcpOk,
    walksSeen: ledger.walksSeen,
    walksBlocked: ledger.walksBlocked,
    insight: ledgerInsight({
      injects: ledger.injects,
      mcpCalls: ledger.mcpCalls,
      mcpOk: ledger.mcpOk,
      tokensAvoided: ledger.tokensAvoided,
      spentTokens: ledger.spentTokens,
      hasSamples: hasTokenSamples,
    }),
  };
}

export function eventTypeMix(events: MetricEvent[]): CountRow[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const label = KNOWN_EVENT_TYPES.has(e.type) ? e.type : 'other';
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export function workspaceRollup(events: MetricEvent[]): WorkspaceUsageRow[] {
  const groups = new Map<string, MetricEvent[]>();
  for (const e of events) {
    const key = e.workspace ? normalizeWorkspace(e.workspace) : UNTAGGED_WORKSPACE;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([workspace, evs]) => {
      const ledger = tokenLedger(evs);
      const hasSamples = evs.length > 0;
      return {
        workspace,
        injects: ledger.injects,
        mcpCalls: ledger.mcpCalls,
        spentTokens: hasSamples ? ledger.spentTokens : null,
        netTokens: hasSamples ? ledger.net : null,
      };
    })
    .sort((a, b) => (b.spentTokens ?? 0) - (a.spentTokens ?? 0) || b.injects - a.injects);
}

export function collectDualMetrics(workspace: string): DualMetrics {
  const all = readMetrics();
  const project = filterProjectEvents(all, workspace);
  return {
    projectMetrics: summarizeEvents(project),
    globalMetrics: summarizeEvents(all),
    workspaces: workspaceRollup(all),
    untaggedEvents: all.filter((e) => !e.workspace).length,
    eventMix: eventTypeMix(all),
  };
}
