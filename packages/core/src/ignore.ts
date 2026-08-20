import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PATTERNS, DEFAULT_KEEP_DIRS } from './types.js';

function loadPatternFile(workspace: string, name: string): string[] {
  const path = join(workspace, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
}

function patternToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/');
  // Leading slash anchors to the workspace root (gitignore semantics).
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ':::GLOBSTAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::GLOBSTAR:::/g, '.*');
  return anchored ? new RegExp(`^${escaped}(/|$)`) : new RegExp(`(^|/)${escaped}(/|$)`);
}

function toRule(pattern: string): IgnoreRule {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  return { regex: patternToRegex(body), negated };
}

export class IgnoreMatcher {
  private readonly rules: IgnoreRule[];

  constructor(workspace: string) {
    // Order matters (last match wins): keep-dirs beat gitignore so test/
    // outside src/ stays searchable; .fastpathignore can still re-ignore
    // noisy subtrees (e.g. test/fixtures/).
    const patterns = [
      ...[...DEFAULT_IGNORE_DIRS].map((d) => `${d}/`),
      ...DEFAULT_IGNORE_PATTERNS,
      ...loadPatternFile(workspace, '.gitignore'),
      ...loadPatternFile(workspace, '.kiroignore'),
      ...[...DEFAULT_KEEP_DIRS].map((d) => `!${d}/`),
      ...loadPatternFile(workspace, '.fastpathignore'),
    ];
    this.rules = patterns.map(toRule);
  }

  ignores(workspace: string, absolutePath: string): boolean {
    const rel = relative(workspace, absolutePath).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return true;
    // gitignore semantics: the last matching rule wins.
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(rel)) ignored = !rule.negated;
    }
    return ignored;
  }
}
