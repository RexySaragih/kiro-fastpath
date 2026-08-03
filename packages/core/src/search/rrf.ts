import { IndexLimits, type SearchHit } from '../types.js';

/** Reciprocal Rank Fusion across ranked lists. */
export function fuseRrf(lists: SearchHit[][], topK: number): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.path}::${hit.symbol ?? ''}::${hit.line ?? ''}`;
      const add = 1 / (IndexLimits.RRF_K + rank + 1);
      const prev = scores.get(key);
      if (prev) {
        prev.score += add;
        if (hit.snippet.length > prev.hit.snippet.length) prev.hit = hit;
      } else {
        scores.set(key, { hit, score: add });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }));
}

export type QueryKind = 'identifier' | 'natural' | 'mixed';

export function classifyQuery(query: string): QueryKind {
  const q = query.trim();
  if (!q) return 'mixed';
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(q)) return 'identifier';
  if (/\s/.test(q) && /[a-z]{3,}/.test(q) && !/[A-Z]{2,}/.test(q)) return 'natural';
  return 'mixed';
}
