/**
 * End-to-end token benchmark: replay tasks with injection on and off.
 *
 * What is measured exactly: tokens injected per turn, retrieval latency, hit
 * count, and how many distinct files retrieval pointed at.
 * What is estimated: the discovery cost the agent would pay without retrieval
 * (a directory walk over the candidate dirs plus reading the files it would
 * have to open). Estimates are labelled as such — the walk side cannot be
 * measured without a live agent.
 */
import { readFileSync } from 'node:fs';
import {
  cappedFileTokens,
  contextForTask,
  discoveryWalkTokens,
  type SearchHit,
} from '@fastpath/core';
import { estimateTokens } from './metrics.js';

export interface BenchTask {
  prompt: string;
}

export interface BenchRow {
  prompt: string;
  hits: number;
  files: number;
  retrieveMs: number;
  injectedTokens: number;
  walkTokensEstimated: number;
  readTokensEstimated: number;
}

export interface BenchReport {
  tasks: number;
  injectedTokens: number;
  baselineTokensEstimated: number;
  netTokens: number;
  avgRetrieveMs: number;
  rows: BenchRow[];
}

/** Without retrieval an agent typically opens several candidates per task. */
const BASELINE_FILE_READS = 3;

function readEstimate(workspace: string, hits: SearchHit[]): number {
  const paths = [...new Set(hits.map((h) => h.path))].slice(0, BASELINE_FILE_READS);
  return paths.reduce((sum, rel) => sum + cappedFileTokens(workspace, rel), 0);
}

function hitLoc(h: SearchHit): string {
  if (h.startLine != null && h.endLine != null) {
    return h.startLine === h.endLine
      ? `${h.path}:${h.startLine}`
      : `${h.path}:${h.startLine}-${h.endLine}`;
  }
  return h.line ? `${h.path}:${h.line}` : h.path;
}

function renderInjection(hits: SearchHit[]): string {
  return hits
    .map((h) => `- ${h.symbol ?? h.kind ?? 'hit'} — ${hitLoc(h)}\n${h.snippet ?? ''}`)
    .join('\n');
}

export function loadBenchTasks(path: string): BenchTask[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | { tasks?: Array<string | BenchTask> }
    | Array<string | BenchTask>;
  const raw = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
  return raw.map((t) => (typeof t === 'string' ? { prompt: t } : t));
}

export async function runBench(
  workspace: string,
  tasks: BenchTask[],
): Promise<BenchReport> {
  const walkTokens = discoveryWalkTokens(workspace);
  const rows: BenchRow[] = [];

  for (const task of tasks) {
    const started = Date.now();
    const hits = await contextForTask(workspace, task.prompt, 5);
    const retrieveMs = Date.now() - started;
    rows.push({
      prompt: task.prompt,
      hits: hits.length,
      files: new Set(hits.map((h) => h.path)).size,
      retrieveMs,
      injectedTokens: estimateTokens(renderInjection(hits)),
      walkTokensEstimated: walkTokens,
      readTokensEstimated: readEstimate(workspace, hits),
    });
  }

  const injectedTokens = rows.reduce((n, r) => n + r.injectedTokens, 0);
  const baseline = rows.reduce(
    (n, r) => n + r.walkTokensEstimated + r.readTokensEstimated,
    0,
  );
  return {
    tasks: rows.length,
    injectedTokens,
    baselineTokensEstimated: baseline,
    netTokens: baseline - injectedTokens,
    avgRetrieveMs: rows.length
      ? Math.round(rows.reduce((n, r) => n + r.retrieveMs, 0) / rows.length)
      : 0,
    rows,
  };
}

export function formatBench(report: BenchReport): string {
  const lines = [
    `bench tasks=${report.tasks} avgRetrieveMs=${report.avgRetrieveMs}`,
    `tokens injected=${report.injectedTokens} (measured)`,
    `tokens baseline≈${report.baselineTokensEstimated} (estimated walk + ${BASELINE_FILE_READS} whole-file reads/task)`,
    `net≈${report.netTokens}`,
    '',
  ];
  for (const row of report.rows) {
    lines.push(
      `  ${row.injectedTokens} tok · ${row.hits} hits · ${row.files} files · ${row.retrieveMs}ms — ${row.prompt}`,
    );
  }
  return lines.join('\n');
}
