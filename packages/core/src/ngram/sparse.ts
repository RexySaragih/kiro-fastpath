import { createHash } from 'node:crypto';

/** CRC32-ish deterministic weight for character pairs (Cursor/GitHub sparse n-gram style). */
function pairWeight(a: number, b: number): number {
  const h = createHash('sha256');
  h.update(Buffer.from([a & 0xff, b & 0xff]));
  return h.digest().readUInt32BE(0);
}

/** Extract all sparse n-grams from text (index-time). */
export function buildAllNgrams(text: string, maxLen = 12): string[] {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 2) return [];
  const weights: number[] = [];
  for (let i = 0; i < bytes.length - 1; i++) {
    weights.push(pairWeight(bytes[i]!, bytes[i + 1]!));
  }

  const out = new Set<string>();
  for (let i = 0; i < weights.length; i++) {
    let maxInside = -1;
    for (let j = i; j < weights.length && j - i + 2 <= maxLen; j++) {
      if (j > i) maxInside = Math.max(maxInside, weights[j - 1]!);
      const left = weights[i]!;
      const right = weights[j]!;
      if (left > maxInside && right > maxInside) {
        out.add(bytes.subarray(i, j + 2).toString('utf8'));
      }
    }
  }
  return [...out];
}

/** Minimal covering n-grams for a literal query string. */
export function buildCovering(text: string, maxLen = 12): string[] {
  const all = buildAllNgrams(text, maxLen);
  if (!all.length) return text.length ? [text.slice(0, Math.min(3, text.length))] : [];
  // Prefer longer n-grams first for selectivity
  all.sort((a, b) => b.length - a.length);
  const covered = new Array(text.length).fill(false);
  const chosen: string[] = [];
  for (const ng of all) {
    const idx = text.indexOf(ng);
    if (idx < 0) continue;
    let adds = false;
    for (let i = idx; i < idx + ng.length; i++) {
      if (!covered[i]) {
        covered[i] = true;
        adds = true;
      }
    }
    if (adds) chosen.push(ng);
    if (covered.every(Boolean)) break;
  }
  return chosen.length ? chosen : all.slice(0, 3);
}

export function ngramHash(ng: string): string {
  return createHash('sha256').update(ng).digest('hex').slice(0, 16);
}

/** Extract literal runs from a simple regex-ish pattern for indexing lookup. */
export function literalsFromPattern(pattern: string): string[] {
  // Strip common regex metachar wrappers; keep contiguous literal runs
  const cleaned = pattern.replace(/\\[ntr]/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, ' ');
  return cleaned
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}
