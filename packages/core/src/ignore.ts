import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DEFAULT_IGNORE_DIRS } from './types.js';

function loadPatternFile(workspace: string, name: string): string[] {
  const path = join(workspace, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function patternToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/');
  if (p.endsWith('/')) p = p.slice(0, -1);
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ':::GLOBSTAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::GLOBSTAR:::/g, '.*');
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

export class IgnoreMatcher {
  private readonly regexes: RegExp[];

  constructor(workspace: string) {
    const patterns = [
      ...[...DEFAULT_IGNORE_DIRS].map((d) => `${d}/`),
      ...loadPatternFile(workspace, '.gitignore'),
      ...loadPatternFile(workspace, '.kiroignore'),
      ...loadPatternFile(workspace, '.fastpathignore'),
    ];
    this.regexes = patterns.map(patternToRegex);
  }

  ignores(workspace: string, absolutePath: string): boolean {
    const rel = relative(workspace, absolutePath).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return true;
    return this.regexes.some((re) => re.test(rel));
  }
}
