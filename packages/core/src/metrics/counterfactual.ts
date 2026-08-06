import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { walkIndexableFiles } from '../index/indexer.js';
import { isQualityHit } from '../window.js';
import type { SearchHit } from '../types.js';
import { claimDiscovery, claimPath } from './credit-state.js';
import {
  CHARS_PER_TOKEN,
  FILE_COUNTERFACTUAL_CAP_TOKENS,
  WALK_ENTRY_CHARS,
  estimateTokens,
} from './estimate.js';

/** Estimated tokens to list all indexable files (discovery walk counterfactual). */
export function discoveryWalkTokens(workspace: string): number {
  try {
    const n = walkIndexableFiles(workspace).length;
    return Math.ceil((n * WALK_ENTRY_CHARS) / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/** Capped full-file token estimate for a workspace-relative path. */
export function cappedFileTokens(workspace: string, relPath: string): number {
  const abs = join(workspace, relPath);
  try {
    if (!existsSync(abs)) return 0;
    const chars = statSync(abs).size;
    return Math.min(
      FILE_COUNTERFACTUAL_CAP_TOKENS,
      Math.ceil(chars / CHARS_PER_TOKEN),
    );
  } catch {
    return 0;
  }
}

/**
 * Estimated savings of delivering `deliveredTokens` instead of reading the whole file.
 * Does not claim path — caller should claim first.
 */
export function windowVsFileTokens(
  workspace: string,
  relPath: string,
  deliveredTokens: number,
): number {
  const fileTok = cappedFileTokens(workspace, relPath);
  if (fileTok <= 0) return 0;
  return Math.max(0, fileTok - Math.max(0, deliveredTokens));
}

export interface LocateCredit {
  windowVsFileTokens: number;
  discoveryTokens: number;
  paths: string[];
}

/**
 * Credit unique quality hit paths (snippet/body as delivered) + optional discovery.
 * Empty hits → zeros. Path and discovery claims are session-deduped.
 */
export function creditLocateHits(
  workspace: string,
  hits: SearchHit[],
  options: { claimDiscoveryIfHits?: boolean } = {},
): LocateCredit {
  const claimDiscoveryIfHits = options.claimDiscoveryIfHits !== false;
  const quality = hits.filter(isQualityHit);
  if (!quality.length) {
    return { windowVsFileTokens: 0, discoveryTokens: 0, paths: [] };
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  let windowVsFile = 0;
  for (const hit of quality) {
    const path = hit.path.trim().replace(/\\/g, '/');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (!claimPath(path)) continue;
    paths.push(path);
    const delivered = estimateTokens(hit.snippet ?? '');
    windowVsFile += windowVsFileTokens(workspace, path, delivered);
  }

  let discoveryTokens = 0;
  if (claimDiscoveryIfHits && claimDiscovery()) {
    discoveryTokens = discoveryWalkTokens(workspace);
  }

  return { windowVsFileTokens: windowVsFile, discoveryTokens, paths };
}

/**
 * Credit a single window read (path + delivered body tokens) + no discovery by default.
 */
export function creditWindowRead(
  workspace: string,
  relPath: string,
  deliveredTokens: number,
): LocateCredit {
  const path = relPath.trim().replace(/\\/g, '/');
  if (!path) {
    return { windowVsFileTokens: 0, discoveryTokens: 0, paths: [] };
  }
  if (!claimPath(path)) {
    return { windowVsFileTokens: 0, discoveryTokens: 0, paths: [] };
  }
  return {
    windowVsFileTokens: windowVsFileTokens(workspace, path, deliveredTokens),
    discoveryTokens: 0,
    paths: [path],
  };
}
