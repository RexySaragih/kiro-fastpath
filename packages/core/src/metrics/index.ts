export {
  CHARS_PER_TOKEN,
  FILE_COUNTERFACTUAL_CAP_TOKENS,
  WALK_ENTRY_CHARS,
  WALK_TOKENS_AVOIDED,
  estimateTokens,
} from './estimate.js';
export {
  userFastpathDir,
  metricsPath,
  ledgerStatePath,
} from './paths.js';
export type { InjectMode, MetricEvent } from './types.js';
export {
  LOG_MAX_BYTES,
  appendRotatingLine,
  appendMetric,
  readMetrics,
} from './journal.js';
export {
  resetLedgerState,
  claimPath,
  claimDiscovery,
} from './credit-state.js';
export {
  discoveryWalkTokens,
  cappedFileTokens,
  windowVsFileTokens,
  creditLocateHits,
  creditWindowRead,
  type LocateCredit,
} from './counterfactual.js';
export { tokenLedger, type TokenLedger } from './ledger.js';
