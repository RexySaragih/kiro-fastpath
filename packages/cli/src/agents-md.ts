/**
 * Workspace-root AGENTS.md — Kiro Default agent always loads this file.
 * Managed by FastPath (marker <!-- fastpath:caveman -->).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS_MD_MARKER = '<!-- fastpath:caveman -->';

/** One sticky line for inject / session-start (Default agent nudge). */
export const CAVEMAN_OUTPUT_NUDGE = 'OUTPUT MODE = caveman full.';

export function agentsMdPath(workspace: string): string {
  return join(workspace, 'AGENTS.md');
}

/**
 * Write or refresh FastPath-managed AGENTS.md.
 * - Missing → write template
 * - Ours (starts with marker / only our block) → overwrite from template
 * - Foreign (no marker) → append FastPath section once
 * - Foreign + already appended → refresh appended block from template
 */
export function ensureAgentsMd(workspace: string, templatePath: string): void {
  if (!existsSync(templatePath)) return;
  const dest = agentsMdPath(workspace);
  const template = readFileSync(templatePath, 'utf8');
  const body = template.endsWith('\n') ? template : `${template}\n`;

  if (!existsSync(dest)) {
    writeFileSync(dest, body);
    return;
  }

  const existing = readFileSync(dest, 'utf8');
  const idx = existing.indexOf(AGENTS_MD_MARKER);
  if (idx < 0) {
    writeFileSync(dest, `${existing.trimEnd()}\n\n${body}`);
    return;
  }
  const before = existing.slice(0, idx).trimEnd();
  if (!before) {
    writeFileSync(dest, body);
    return;
  }
  writeFileSync(dest, `${before}\n\n${body}`);
}

export function ensureAgentsMdFromPack(workspace: string, agentPackDir: string): void {
  ensureAgentsMd(workspace, join(agentPackDir, 'AGENTS.md'));
}

/** Remove FastPath AGENTS.md block; delete file if nothing else remains. */
export function removeManagedAgentsMd(workspace: string): void {
  const dest = agentsMdPath(workspace);
  if (!existsSync(dest)) return;
  const existing = readFileSync(dest, 'utf8');
  const idx = existing.indexOf(AGENTS_MD_MARKER);
  if (idx < 0) return;
  const before = existing.slice(0, idx).trimEnd();
  if (!before) {
    unlinkSync(dest);
    return;
  }
  writeFileSync(dest, `${before}\n`);
}
