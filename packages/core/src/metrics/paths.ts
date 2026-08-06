import { homedir } from 'node:os';
import { join } from 'node:path';

/** Overridable for tests and sandboxed environments. */
export function userFastpathDir(): string {
  return process.env.FASTPATH_USER_DIR?.trim() || join(homedir(), '.fastpath');
}

export function metricsPath(): string {
  return join(userFastpathDir(), 'metrics.jsonl');
}

export function ledgerStatePath(): string {
  return join(userFastpathDir(), 'token-ledger-state.json');
}
