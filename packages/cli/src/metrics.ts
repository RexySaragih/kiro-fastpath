import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { metricsPath, userFastpathDir } from './config.js';

/** ~4 chars per token — good enough for budgets and A/B ledgers. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Tokens a repo walk would plausibly have cost had retrieval not answered.
 * Conservative: one listDirectory of a mid-size dir plus the reads it triggers.
 */
export const WALK_TOKENS_AVOIDED = 1200;

export type InjectMode = 'on' | 'off';

export type MetricEvent =
  | {
      type: 'inject';
      at: string;
      session?: string;
      mode?: InjectMode;
      dirty: number;
      deltaMs: number;
      retrieveMs: number;
      hits: number;
      /** Tokens actually written into agent context by this inject. */
      injectedTokens?: number;
      timedOutDelta: boolean;
      timedOutRetrieve: boolean;
    }
  | {
      type: 'guardrail';
      at: string;
      session?: string;
      tool: string;
      blocked: boolean;
      /** Tokens the block plausibly avoided (0 when not blocked). */
      tokensAvoided: number;
    }
  | {
      type: 'index';
      at: string;
      mode: 'full' | 'git' | 'paths';
      filesIndexed: number;
      ms: number;
    }
  | {
      type: 'doctor';
      at: string;
      ready: boolean;
      issueCount: number;
    }
  | {
      type: 'file-event';
      at: string;
      action: 'index' | 'delete';
      files: number;
      ms: number;
    }
  | {
      type: 'session-start';
      at: string;
      gitDelta: number;
      ms: number;
    };

/** Rotate at 2 MB, keeping one previous generation. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append to a JSONL log with size-based rotation — these files are written on
 * every turn and every intercepted tool call, so unbounded growth is real.
 */
export function appendRotatingLine(path: string, line: string, maxBytes = LOG_MAX_BYTES): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    if (existsSync(path) && statSync(path).size > maxBytes) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    /* never break caller */
  }
}

export function appendMetric(event: MetricEvent): void {
  appendRotatingLine(metricsPath(), JSON.stringify(event));
}

export function readMetrics(limit = 200): MetricEvent[] {
  const path = metricsPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const slice = lines.slice(-limit);
  const out: MetricEvent[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as MetricEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}

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

export interface TokenLedger {
  injects: number;
  injectedTokens: number;
  tokensAvoided: number;
  net: number;
  byMode: Record<InjectMode, { injects: number; injectedTokens: number }>;
}

/**
 * The product's central claim is "fewer tokens". Ledger it explicitly:
 * tokens we injected versus tokens the guardrail plausibly avoided.
 */
export function tokenLedger(events: MetricEvent[]): TokenLedger {
  const injects = events.filter(
    (e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject',
  );
  const guards = events.filter(
    (e): e is Extract<MetricEvent, { type: 'guardrail' }> => e.type === 'guardrail',
  );
  const byMode: TokenLedger['byMode'] = {
    on: { injects: 0, injectedTokens: 0 },
    off: { injects: 0, injectedTokens: 0 },
  };
  let injectedTokens = 0;
  for (const i of injects) {
    const tokens = i.injectedTokens ?? 0;
    injectedTokens += tokens;
    const bucket = byMode[i.mode ?? 'on'];
    bucket.injects += 1;
    bucket.injectedTokens += tokens;
  }
  const tokensAvoided = guards.reduce((sum, g) => sum + g.tokensAvoided, 0);
  return {
    injects: injects.length,
    injectedTokens,
    tokensAvoided,
    net: tokensAvoided - injectedTokens,
    byMode,
  };
}

export function summarizeMetrics(events: MetricEvent[]): string {
  const injects = events.filter((e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject');
  const indexes = events.filter((e) => e.type === 'index');
  const doctors = events.filter((e) => e.type === 'doctor');
  const guards = events.filter(
    (e): e is Extract<MetricEvent, { type: 'guardrail' }> => e.type === 'guardrail',
  );
  const lines = [
    `events=${events.length} inject=${injects.length} index=${indexes.length} doctor=${doctors.length} guardrail=${guards.length}`,
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
  if (ledger.injects) {
    const avg = Math.round(ledger.injectedTokens / Math.max(1, ledger.byMode.on.injects));
    lines.push(
      `tokens injected=${ledger.injectedTokens} (avg ${avg}/turn on) avoided≈${ledger.tokensAvoided} net≈${ledger.net}`,
    );
    if (ledger.byMode.off.injects) {
      lines.push(
        `A/B modes on=${ledger.byMode.on.injects} turns, off=${ledger.byMode.off.injects} turns (FASTPATH_INJECT)`,
      );
    }
  }
  const blocked = guards.filter((g) => g.blocked).length;
  if (guards.length) {
    lines.push(`walks seen=${guards.length} blocked=${blocked}`);
  }
  return lines.join('\n');
}
