import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { metricsPath, userFastpathDir } from './config.js';

export type MetricEvent =
  | {
      type: 'inject';
      at: string;
      dirty: number;
      deltaMs: number;
      retrieveMs: number;
      hits: number;
      timedOutDelta: boolean;
      timedOutRetrieve: boolean;
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
    };

export function appendMetric(event: MetricEvent): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    appendFileSync(metricsPath(), `${JSON.stringify(event)}\n`);
  } catch {
    /* never break caller */
  }
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

export function summarizeMetrics(events: MetricEvent[]): string {
  const injects = events.filter((e): e is Extract<MetricEvent, { type: 'inject' }> => e.type === 'inject');
  const indexes = events.filter((e) => e.type === 'index');
  const doctors = events.filter((e) => e.type === 'doctor');
  const lines = [
    `events=${events.length} inject=${injects.length} index=${indexes.length} doctor=${doctors.length}`,
  ];
  if (injects.length) {
    const withHits = injects.filter((i) => i.hits > 0).length;
    const deltas = [...injects.map((i) => i.deltaMs)].sort((a, b) => a - b);
    const p50 = deltas[Math.floor(deltas.length / 2)] ?? 0;
    const timedOut = injects.filter((i) => i.timedOutDelta || i.timedOutRetrieve).length;
    lines.push(
      `inject hitRate=${((withHits / injects.length) * 100).toFixed(1)}% p50deltaMs=${p50} timeouts=${timedOut}`,
    );
  }
  return lines.join('\n');
}
