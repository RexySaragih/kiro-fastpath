import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getEmbedBackend } from '../embed/backend.js';
import { IndexLimits, type SearchHit } from '../types.js';

export const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

type Ranker = (pairs: Array<[string, string]>) => Promise<number[]>;

let rankerPromise: Promise<Ranker | null> | null = null;

function cacheDir(): string {
  const override = process.env.FASTPATH_MODEL_CACHE?.trim();
  if (override) return override;
  return join(homedir(), '.fastpath', 'models');
}

function rerankEnabled(): boolean {
  const raw = (process.env.FASTPATH_RERANK || '').toLowerCase().trim();
  if (raw === 'off' || raw === '0' || raw === 'false') return false;
  if (raw === 'on' || raw === '1' || raw === 'true') return true;
  // Default: on when using MiniLM, off for hash/tests
  return getEmbedBackend() === 'minilm';
}

async function loadRanker(): Promise<Ranker | null> {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir();
    env.allowLocalModels = true;
    const classifier = await pipeline('text-classification', RERANK_MODEL, {
      dtype: 'fp32',
    });

    return async (pairs) => {
      const scores: number[] = [];
      for (const [query, passage] of pairs) {
        const text = `${query} [SEP] ${passage}`.slice(0, 1500);
        const out = await classifier(text);
        const rows = Array.isArray(out) ? out : [out];
        const first = rows[0] as { label?: string; score?: number } | undefined;
        scores.push(typeof first?.score === 'number' ? first.score : 0);
      }
      return scores;
    };
  } catch (err) {
    console.error(
      '[fastpath] reranker unavailable:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function ensureRanker(): Promise<Ranker | null> {
  if (!rerankEnabled()) return null;
  if (!rankerPromise) rankerPromise = loadRanker();
  return rankerPromise;
}

function hitText(hit: SearchHit): string {
  return [hit.symbol, hit.kind, hit.path, hit.snippet].filter(Boolean).join(' ').slice(0, 800);
}

/** Rerank hybrid hits with a local cross-encoder. No-op when disabled/unavailable. */
export async function rerankHits(
  query: string,
  hits: SearchHit[],
  keep: number,
): Promise<SearchHit[]> {
  if (!hits.length || keep <= 0) return hits;
  if (!rerankEnabled()) return hits.slice(0, keep);

  const ranker = await ensureRanker();
  if (!ranker) return hits.slice(0, keep);

  const candidates = hits.slice(0, IndexLimits.RERANK_CANDIDATES);
  const pairs = candidates.map((h) => [query, hitText(h)] as [string, string]);
  try {
    const scores = await ranker(pairs);
    const ranked = candidates
      .map((hit, i) => ({ hit, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, keep)
      .map(({ hit, score }) => ({ ...hit, score }));
    return ranked;
  } catch (err) {
    console.error(
      '[fastpath] rerank failed:',
      err instanceof Error ? err.message : err,
    );
    return hits.slice(0, keep);
  }
}

export async function warmReranker(): Promise<boolean> {
  if ((process.env.FASTPATH_RERANK || '').toLowerCase() === 'off') return false;
  // Force-attempt load regardless of embed backend for warm command
  const prev = process.env.FASTPATH_RERANK;
  process.env.FASTPATH_RERANK = 'on';
  rankerPromise = null;
  try {
    const ranker = await loadRanker();
    rankerPromise = Promise.resolve(ranker);
    return Boolean(ranker);
  } finally {
    if (prev === undefined) delete process.env.FASTPATH_RERANK;
    else process.env.FASTPATH_RERANK = prev;
  }
}

export function resetRerankerForTests(): void {
  rankerPromise = null;
}
