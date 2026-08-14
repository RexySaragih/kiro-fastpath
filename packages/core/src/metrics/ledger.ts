import type { InjectMode, MetricEvent } from './types.js';

export interface TokenLedger {
  injects: number;
  injectedTokens: number;
  mcpResponseTokens: number;
  spentTokens: number;
  avoidedBlockedWalk: number;
  avoidedWindowVsFile: number;
  avoidedDiscovery: number;
  /** Sum of estimated avoid buckets. */
  tokensAvoided: number;
  net: number;
  mcpCalls: number;
  mcpOk: number;
  walksSeen: number;
  walksBlocked: number;
  byMode: Record<InjectMode, { injects: number; injectedTokens: number }>;
}

/**
 * Measured spend vs estimated avoid buckets.
 * net = tokensAvoided − spentTokens (mixed honesty — UI must label ≈).
 */
export function tokenLedger(events: MetricEvent[], workspace?: string): TokenLedger {
  const scopedEvents = workspace
    ? events.filter((e) => !('workspace' in e) || !e.workspace || e.workspace === workspace)
    : events;
  const targetEvents = scopedEvents.length ? scopedEvents : events;
  const injects = targetEvents.filter(
    (e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject',
  );
  const guards = targetEvents.filter(
    (e): e is Extract<MetricEvent, { type: 'guardrail' }> => e.type === 'guardrail',
  );
  const mcps = targetEvents.filter(
    (e): e is Extract<MetricEvent, { type: 'mcp' }> => e.type === 'mcp',
  );

  const byMode: TokenLedger['byMode'] = {
    on: { injects: 0, injectedTokens: 0 },
    off: { injects: 0, injectedTokens: 0 },
  };
  let injectedTokens = 0;
  let avoidedWindowVsFile = 0;
  let avoidedDiscovery = 0;
  for (const i of injects) {
    const tokens = i.injectedTokens ?? 0;
    injectedTokens += tokens;
    avoidedWindowVsFile += i.windowVsFileTokens ?? 0;
    avoidedDiscovery += i.discoveryTokens ?? 0;
    const bucket = byMode[i.mode ?? 'on'];
    bucket.injects += 1;
    bucket.injectedTokens += tokens;
  }

  let mcpResponseTokens = 0;
  let mcpOk = 0;
  for (const m of mcps) {
    mcpResponseTokens += m.responseTokens;
    if (m.ok) mcpOk += 1;
    avoidedWindowVsFile += m.windowVsFileTokens;
    avoidedDiscovery += m.discoveryTokens;
  }

  const avoidedBlockedWalk = guards.reduce((sum, g) => sum + g.tokensAvoided, 0);
  const tokensAvoided = avoidedBlockedWalk + avoidedWindowVsFile + avoidedDiscovery;
  const spentTokens = injectedTokens + mcpResponseTokens;

  return {
    injects: injects.length,
    injectedTokens,
    mcpResponseTokens,
    spentTokens,
    avoidedBlockedWalk,
    avoidedWindowVsFile,
    avoidedDiscovery,
    tokensAvoided,
    net: tokensAvoided - spentTokens,
    mcpCalls: mcps.length,
    mcpOk,
    walksSeen: guards.length,
    walksBlocked: guards.filter((g) => g.blocked).length,
    byMode,
  };
}
