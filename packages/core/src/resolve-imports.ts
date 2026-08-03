import { existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', ''];

/** Best-effort resolve relative/alias-free import specifier to a workspace-relative path. */
export function resolveImport(
  fromPath: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    // bare package — keep unresolved
    return null;
  }

  const fromDir = dirname(fromPath);
  const base = normalize(join(fromDir, specifier)).replace(/\\/g, '/');
  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => join(base, `index${e}`).replace(/\\/g, '/')),
  ];

  for (const c of candidates) {
    const norm = c.replace(/^\.\//, '');
    if (knownFiles.has(norm)) return norm;
  }
  return null;
}

export function fileExistsInWorkspace(workspace: string, rel: string): boolean {
  return existsSync(join(workspace, rel));
}
