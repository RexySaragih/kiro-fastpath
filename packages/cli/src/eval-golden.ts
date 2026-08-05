/**
 * Graded retrieval evaluation.
 *
 * The smoke eval only asks "did anything come back", which cannot tell whether
 * a retrieval change helped. This one scores ranked results against a golden
 * set with graded relevance and reports recall@k, MRR and nDCG@10 — the numbers
 * that make changes like body-aware chunk embedding falsifiable.
 *
 * Golden cases live in `fixtures/golden.json` so real prompts captured via
 * FASTPATH_HOOK_DEBUG can be appended without touching code.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextForTask,
  getEmbedBackend,
  indexWorkspace,
  searchIndex,
  type SearchHit,
} from '@fastpath/core';

export interface GoldenCase {
  query: string;
  /** `path` or `path#symbol` → grade (3 = ideal, 2 = useful, 1 = marginal). */
  relevant: Record<string, number>;
  mode?: 'search' | 'context';
}

export interface GoldenMetrics {
  cases: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  perCase: Array<{ query: string; recallAt5: number; rr: number; ndcg: number }>;
}

const NDCG_CUTOFF = 10;

/** Built-in cases for fixtures/sample-src; extended by fixtures/golden.json. */
const BUILTIN_CASES: GoldenCase[] = [
  {
    query: 'where do we validate the auth token',
    relevant: { 'src/auth.ts#validateJwt': 3, 'src/auth.ts': 2 },
  },
  {
    query: 'user login flow',
    relevant: { 'src/auth.ts#AuthService.login': 3, 'src/auth.ts': 2, 'src/app.ts': 1 },
  },
  {
    query: 'AuthService',
    relevant: { 'src/auth.ts#AuthService': 3, 'src/auth.ts': 2 },
  },
  {
    query: 'how is tax calculated',
    relevant: { 'src/billing.py#calculate_tax': 3, 'src/billing.py': 2 },
  },
  {
    query: 'application entry point wiring',
    relevant: { 'src/app.ts': 3 },
  },
];

function gradeFor(hit: SearchHit, relevant: Record<string, number>): number {
  if (hit.symbol) {
    const keyed = relevant[`${hit.path}#${hit.symbol}`];
    if (keyed !== undefined) return keyed;
  }
  return relevant[hit.path] ?? 0;
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, g, i) => sum + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
}

export function scoreCase(hits: SearchHit[], relevant: Record<string, number>) {
  // Each golden item counts once: repeated hits on the same file must not
  // inflate the gain (that used to push nDCG above 1).
  const credited = new Set<string>();
  const grades = hits.map((hit) => {
    const grade = gradeFor(hit, relevant);
    if (!grade) return 0;
    const key =
      hit.symbol && relevant[`${hit.path}#${hit.symbol}`] !== undefined
        ? `${hit.path}#${hit.symbol}`
        : hit.path;
    if (credited.has(key)) return 0;
    credited.add(key);
    return grade;
  });
  const totalRelevant = Object.keys(relevant).length;

  const foundAt = (k: number): number => {
    const seen = new Set<string>();
    grades.slice(0, k).forEach((g, i) => {
      if (g > 0) seen.add(`${hits[i]!.path}#${hits[i]!.symbol ?? ''}`);
    });
    return Math.min(1, seen.size / Math.max(1, Math.min(totalRelevant, k)));
  };

  const firstRelevant = grades.findIndex((g) => g > 0);
  const ideal = Object.values(relevant)
    .sort((a, b) => b - a)
    .slice(0, NDCG_CUTOFF);
  const idealDcg = dcg(ideal);

  return {
    recallAt5: foundAt(5),
    recallAt10: foundAt(10),
    rr: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    ndcg: idealDcg ? dcg(grades.slice(0, NDCG_CUTOFF)) / idealDcg : 0,
  };
}

export function loadGoldenCases(fixtureRoot: string): GoldenCase[] {
  const extra = join(fixtureRoot, 'fixtures/golden.json');
  if (!existsSync(extra)) return BUILTIN_CASES;
  try {
    const parsed = JSON.parse(readFileSync(extra, 'utf8')) as { cases?: GoldenCase[] };
    return [...BUILTIN_CASES, ...(parsed.cases ?? [])];
  } catch {
    return BUILTIN_CASES;
  }
}

export async function runGoldenEval(fixtureRoot: string): Promise<GoldenMetrics> {
  const cases = loadGoldenCases(fixtureRoot);
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-golden-'));
  try {
    cpSync(join(fixtureRoot, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const perCase: GoldenMetrics['perCase'] = [];
    let recall5 = 0;
    let recall10 = 0;
    let mrr = 0;
    let ndcg = 0;

    for (const c of cases) {
      const hits =
        c.mode === 'context'
          ? await contextForTask(dir, c.query, 8)
          : await searchIndex(dir, c.query, { topK: NDCG_CUTOFF });
      const scored = scoreCase(hits, c.relevant);
      recall5 += scored.recallAt5;
      recall10 += scored.recallAt10;
      mrr += scored.rr;
      ndcg += scored.ndcg;
      perCase.push({
        query: c.query,
        recallAt5: scored.recallAt5,
        rr: scored.rr,
        ndcg: scored.ndcg,
      });
    }

    const n = Math.max(1, cases.length);
    return {
      cases: cases.length,
      recallAt5: recall5 / n,
      recallAt10: recall10 / n,
      mrr: mrr / n,
      ndcgAt10: ndcg / n,
      perCase,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * CI gate. Thresholds are per embedding backend: the hash backend used in tests
 * is deliberately weaker than the shipped MiniLM, so one number would either
 * fail CI or excuse real regressions.
 */
export const GOLDEN_THRESHOLDS = {
  hash: { recallAt5: 0.5, mrr: 0.6, ndcgAt10: 0.45 },
  minilm: { recallAt5: 0.65, mrr: 0.75, ndcgAt10: 0.6 },
} as const;

export interface GoldenThresholds {
  recallAt5: number;
  mrr: number;
  ndcgAt10: number;
}

export function thresholdsForBackend(): GoldenThresholds {
  return getEmbedBackend() === 'minilm' ? GOLDEN_THRESHOLDS.minilm : GOLDEN_THRESHOLDS.hash;
}

export function formatGolden(metrics: GoldenMetrics): string {
  const lines = [
    `golden cases=${metrics.cases}`,
    `recall@5=${metrics.recallAt5.toFixed(3)} recall@10=${metrics.recallAt10.toFixed(3)} MRR=${metrics.mrr.toFixed(3)} nDCG@10=${metrics.ndcgAt10.toFixed(3)}`,
  ];
  for (const c of metrics.perCase) {
    lines.push(
      `  ${c.recallAt5 > 0 ? 'hit ' : 'MISS'} rr=${c.rr.toFixed(2)} ndcg=${c.ndcg.toFixed(2)} — ${c.query}`,
    );
  }
  return lines.join('\n');
}

export function goldenFailures(metrics: GoldenMetrics): string[] {
  const limits = thresholdsForBackend();
  const out: string[] = [];
  if (metrics.recallAt5 < limits.recallAt5) {
    out.push(`recall@5 ${metrics.recallAt5.toFixed(3)} < ${limits.recallAt5}`);
  }
  if (metrics.mrr < limits.mrr) out.push(`MRR ${metrics.mrr.toFixed(3)} < ${limits.mrr}`);
  if (metrics.ndcgAt10 < limits.ndcgAt10) {
    out.push(`nDCG@10 ${metrics.ndcgAt10.toFixed(3)} < ${limits.ndcgAt10}`);
  }
  return out;
}
