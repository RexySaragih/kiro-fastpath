/**
 * CLI metrics facade — journal + ledger live in @fastpath/core so MCP can share them.
 */
export {
  CHARS_PER_TOKEN,
  WALK_TOKENS_AVOIDED,
  FILE_COUNTERFACTUAL_CAP_TOKENS,
  estimateTokens,
  LOG_MAX_BYTES,
  appendRotatingLine,
  appendMetric,
  readMetrics,
  resetLedgerState,
  creditLocateHits,
  creditWindowRead,
  discoveryWalkTokens,
  cappedFileTokens,
  tokenLedger,
  type InjectMode,
  type MetricEvent,
  type TokenLedger,
} from '@fastpath/core';

import {
  readMetrics,
  tokenLedger,
  type MetricEvent,
  type TokenLedger,
} from '@fastpath/core';

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function histogram(values: number[]): string {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hits, n]) => `${hits}:${n}`)
    .join(' ');
}

export function summarizeMetrics(events: MetricEvent[]): string {
  const injects = events.filter(
    (e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject',
  );
  const indexes = events.filter((e) => e.type === 'index');
  const doctors = events.filter((e) => e.type === 'doctor');
  const guards = events.filter(
    (e): e is Extract<MetricEvent, { type: 'guardrail' }> => e.type === 'guardrail',
  );
  const mcps = events.filter(
    (e): e is Extract<MetricEvent, { type: 'mcp' }> => e.type === 'mcp',
  );
  const lines = [
    `events=${events.length} inject=${injects.length} mcp=${mcps.length}` +
      ` index=${indexes.length} doctor=${doctors.length} guardrail=${guards.length}`,
  ];
  if (injects.length) {
    const withHits = injects.filter((i) => i.hits > 0).length;
    const deltas = [...injects.map((i) => i.deltaMs)].sort((a, b) => a - b);
    const retrieves = [...injects.map((i) => i.retrieveMs)].sort((a, b) => a - b);
    const deltaTimeouts = injects.filter((i) => i.timedOutDelta).length;
    const retrieveTimeouts = injects.filter((i) => i.timedOutRetrieve).length;
    lines.push(
      `inject hitRate=${((withHits / injects.length) * 100).toFixed(1)}%` +
        ` deltaMs p50=${percentile(deltas, 50)} p95=${percentile(deltas, 95)}` +
        ` retrieveMs p50=${percentile(retrieves, 50)} p95=${percentile(retrieves, 95)}`,
    );
    lines.push(`inject hitDist=[${histogram(injects.map((i) => i.hits))}]`);
    lines.push(
      `inject timeouts delta=${deltaTimeouts} retrieve=${retrieveTimeouts} total=${deltaTimeouts + retrieveTimeouts}`,
    );
  }
  const ledger = tokenLedger(events);
  if (ledger.injects || ledger.mcpCalls || ledger.walksSeen) {
    const avg = Math.round(
      ledger.injectedTokens / Math.max(1, ledger.byMode.on.injects),
    );
    lines.push(
      `tokens spent=${ledger.spentTokens} (inject=${ledger.injectedTokens}` +
        (ledger.byMode.on.injects ? ` avg ${avg}/turn` : '') +
        ` mcpOut=${ledger.mcpResponseTokens})` +
        ` avoided≈${ledger.tokensAvoided}` +
        ` (walk=${ledger.avoidedBlockedWalk} window=${ledger.avoidedWindowVsFile}` +
        ` discover=${ledger.avoidedDiscovery})` +
        ` net≈${ledger.net}`,
    );
    if (ledger.byMode.off.injects) {
      lines.push(
        `A/B modes on=${ledger.byMode.on.injects} turns, off=${ledger.byMode.off.injects} turns (FASTPATH_INJECT)`,
      );
    }
  }
  if (ledger.mcpCalls) {
    lines.push(`mcp calls=${ledger.mcpCalls} ok=${ledger.mcpOk}`);
  }
  if (guards.length) {
    lines.push(`walks seen=${ledger.walksSeen} blocked=${ledger.walksBlocked}`);
  }
  return lines.join('\n');
}

/** Convenience for callers that only need a fresh ledger. */
export function currentTokenLedger(limit = 500): TokenLedger {
  return tokenLedger(readMetrics(limit));
}
