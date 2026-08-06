/**
 * Deterministic Scout / Architect routing from prompt keywords + hit spread.
 * Scout max 5 distinct files; Architect from 6+ or multi-file keywords.
 */

const MULTI_FILE_KEYWORDS =
  /\b(feature|refactor|migrat\w*|redesign|restructure|rewrite|implement|architecture|new module|integrat\w*|across|end.?to.?end|system)\b/i;
const SMALL_TASK_KEYWORDS = /\b(fix|typo|bug|tweak|adjust|small|quick|one.?liner?)\b/i;

/** Scout max distinct files; Architect starts at this count. */
export const SCOUT_MAX_FILES = 5;
export const ARCHITECT_MIN_FILES = 6;

export type RoutingConfidence = 'high' | 'medium' | 'low';

export interface RoutingAdvice {
  agent: 'Scout' | 'Architect';
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
  if (distinctFiles <= SCOUT_MAX_FILES && smallKw) {
    return {
      agent: 'Scout',
      confidence: distinctFiles <= 1 ? 'high' : 'medium',
      reason:
        distinctFiles <= 1
          ? 'single file + small keywords'
          : `${distinctFiles} files + small keywords (Scout max ${SCOUT_MAX_FILES})`,
    };
  }
  if (distinctFiles > 0 && distinctFiles <= SCOUT_MAX_FILES) {
    return {
      agent: 'Scout',
      confidence: 'medium',
      reason: `${distinctFiles} files — Scout max ${SCOUT_MAX_FILES}; Default OK for verify`,
    };
  }
  return null;
}

export function formatRoutingLine(advice: RoutingAdvice): string {
  return `**Routing advisor:** prefer ${advice.agent} (${advice.confidence} confidence — ${advice.reason}). Default stays fine for verify; switch when scope fits.`;
}

export function isTinyPrompt(prompt: string): boolean {
  return prompt.length < 30 && SMALL_TASK_KEYWORDS.test(prompt);
}
