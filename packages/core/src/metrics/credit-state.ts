import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ledgerStatePath, userFastpathDir } from './paths.js';

interface LedgerState {
  creditedPaths: string[];
  discoveryClaimed: boolean;
}

function emptyState(): LedgerState {
  return { creditedPaths: [], discoveryClaimed: false };
}

function loadState(): LedgerState {
  const path = ledgerStatePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerState>;
    return {
      creditedPaths: Array.isArray(raw.creditedPaths)
        ? raw.creditedPaths.filter((p): p is string => typeof p === 'string')
        : [],
      discoveryClaimed: raw.discoveryClaimed === true,
    };
  } catch {
    return emptyState();
  }
}

function saveState(state: LedgerState): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    writeFileSync(ledgerStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    /* never break caller */
  }
}

/** Clear path + discovery credits (call on session-start). */
export function resetLedgerState(): void {
  saveState(emptyState());
}

/**
 * Claim a workspace-relative path for window-vs-file credit.
 * Returns true the first time in the session; false if already credited.
 */
export function claimPath(relPath: string): boolean {
  const clean = relPath.trim().replace(/\\/g, '/');
  if (!clean) return false;
  const state = loadState();
  if (state.creditedPaths.includes(clean)) return false;
  state.creditedPaths.push(clean);
  saveState(state);
  return true;
}

/**
 * Claim the once-per-session discovery walk credit.
 * Returns true if this call wins the claim.
 */
export function claimDiscovery(): boolean {
  const state = loadState();
  if (state.discoveryClaimed) return false;
  state.discoveryClaimed = true;
  saveState(state);
  return true;
}
