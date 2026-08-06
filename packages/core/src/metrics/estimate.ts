/** ~4 chars per token — good enough for budgets and A/B ledgers. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Tokens a repo walk would plausibly have cost had retrieval not answered.
 * Conservative flat credit used by the PreToolUse guardrail when a walk is blocked.
 */
export const WALK_TOKENS_AVOIDED = 1200;

/** Cap full-file counterfactual so one huge file cannot dominate the ledger. */
export const FILE_COUNTERFACTUAL_CAP_TOKENS = 8000;

/** Chars in a listing line: "src/modules/auth/guard.service.ts\n". */
export const WALK_ENTRY_CHARS = 40;
