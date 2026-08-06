import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { metricsPath, userFastpathDir } from './paths.js';
import type { MetricEvent } from './types.js';

/** Rotate at 2 MB, keeping one previous generation. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append to a JSONL log with size-based rotation — these files are written on
 * every turn and every intercepted tool call, so unbounded growth is real.
 */
export function appendRotatingLine(
  path: string,
  line: string,
  maxBytes = LOG_MAX_BYTES,
): void {
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
