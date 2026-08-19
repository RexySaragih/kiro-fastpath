/**
 * Deterministic Architect routing from prompt keywords + hit spread.
 * Small edits stay on Default. Architect from 6+ files or multi-file keywords.
 * NO_MATCH gather hint is separate (`formatGatherHint`) — Scout is a sub-agent, not a route.
 */

const MULTI_FILE_KEYWORDS =
  /\b(feature|refactor|migrat\w*|redesign|restructure|rewrite|implement|architecture|new module|integrat\w*|across|end.?to.?end|system)\b/i;
const SMALL_TASK_KEYWORDS = /\b(fix|typo|bug|tweak|adjust|small|quick|one.?liner?)\b/i;

/** Distinct-file count at which Architect is preferred over Default. */
export const ARCHITECT_MIN_FILES = 6;

export type RoutingConfidence = 'high' | 'medium' | 'low';

export interface RoutingAdvice {
  agent: 'Architect';
  confidence: RoutingConfidence;
  reason: string;
}

export function routingAdvice(prompt: string, hitPaths: string[]): RoutingAdvice | null {
  const distinctFiles = new Set(hitPaths).size;
  const multiKw = MULTI_FILE_KEYWORDS.test(prompt);
  const smallKw = SMALL_TASK_KEYWORDS.test(prompt);

  // Strong multi-file language → Architect even when retrieval only found a few files.
  if (multiKw && !smallKw) {
    return {
      agent: 'Architect',
      confidence: distinctFiles >= ARCHITECT_MIN_FILES ? 'high' : 'medium',
      reason: distinctFiles
        ? `${distinctFiles} files + multi-file keywords`
        : 'multi-file keywords',
    };
  }
  if (distinctFiles >= ARCHITECT_MIN_FILES) {
    return {
      agent: 'Architect',
      confidence: 'medium',
      reason: `${distinctFiles} files matched (Architect for 6+)`,
    };
  }
  return null;
}

export function formatRoutingLine(advice: RoutingAdvice): string {
  return `**Routing advisor:** prefer ${advice.agent} (${advice.confidence} confidence — ${advice.reason}). Default stays fine for verify; switch when scope fits.`;
}

export function formatGatherHint(): string {
  return '**Gather hint:** auto-inject missed — spawn Scout. Do not use Kiro built-in Context gathering.';
}

export function isTinyPrompt(prompt: string): boolean {
  return prompt.length < 30 && SMALL_TASK_KEYWORDS.test(prompt);
}

export type PromptIntent = 'code' | 'question' | 'meta';

/** camelCase, PascalCase, snake_case, call, path, or backtick path. */
const CODE_SIGNAL =
  /[A-Z][a-z]+[A-Z]|[a-z]+[A-Z][a-zA-Z]|[a-z]+_[a-z]+|\.\w+\(|[\w./-]+\.[a-zA-Z]{1,5}\b|`[^`]+`/;

const META_VERBS =
  /\b(commit|push|merge|revert|stash|summarize|pull request|thanks|thank you)\b/i;

const QUESTION_VERBS = /\b(explain|why|how does|what is|tell me about)\b/i;

/**
 * Deterministic (no LLM). Code signals win so "commit the AuthService fix"
 * still retrieves. Meta/question skip code windows on inject.
 */
export function classifyIntent(prompt: string): PromptIntent {
  const q = prompt.trim();
  if (!q) return 'meta';
  if (CODE_SIGNAL.test(q)) return 'code';
  if (
    /^(stop|done|thanks|thank you)\b/i.test(q) ||
    /\bexplain what you (did|just did|changed)\b/i.test(q) ||
    META_VERBS.test(q) ||
    /\bpr\b/i.test(q)
  ) {
    return 'meta';
  }
  if (QUESTION_VERBS.test(q)) return 'question';
  return 'code';
}
