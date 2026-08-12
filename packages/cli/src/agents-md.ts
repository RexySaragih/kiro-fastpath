/**
 * Workspace-root AGENTS.md — Kiro Default agent always loads this file.
 * Managed by FastPath (marker <!-- fastpath:agents -->; legacy <!-- fastpath:caveman -->).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_MD_MARKER = "<!-- fastpath:agents -->";
/** Prior marker — still treated as FastPath-managed for refresh/remove. */
export const AGENTS_MD_MARKER_LEGACY = "<!-- fastpath:caveman -->";

/** Sticky lines for inject / session-start (Default agent nudge). */
export const CAVEMAN_OUTPUT_NUDGE =
  "OUTPUT MODE = caveman full. MANDATORY on every response until explicitly disabled.";
export const PONYTAIL_CODE_NUDGE =
  "CODE MODE = ponytail full. MANDATORY when writing or changing code.";

export function agentsMdPath(workspace: string): string {
  return join(workspace, "AGENTS.md");
}

function managedMarkerIndex(body: string): number {
  const primary = body.indexOf(AGENTS_MD_MARKER);
  if (primary >= 0) return primary;
  return body.indexOf(AGENTS_MD_MARKER_LEGACY);
}

/**
 * Write or refresh FastPath-managed AGENTS.md.
 * - Missing → write template
 * - Ours (marker) → overwrite/refresh FastPath block from template
 * - Foreign (no marker) → append FastPath section once
 */
export function ensureAgentsMd(workspace: string, templatePath: string): void {
  if (!existsSync(templatePath)) return;
  const dest = agentsMdPath(workspace);
  const template = readFileSync(templatePath, "utf8");
  const body = template.endsWith("\n") ? template : `${template}\n`;

  if (!existsSync(dest)) {
    writeFileSync(dest, body);
    return;
  }

  const existing = readFileSync(dest, "utf8");
  const idx = managedMarkerIndex(existing);
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

export function ensureAgentsMdFromPack(
  workspace: string,
  agentPackDir: string,
): void {
  ensureAgentsMd(workspace, join(agentPackDir, "AGENTS.md"));
}

/** Remove FastPath AGENTS.md block; delete file if nothing else remains. */
export function removeManagedAgentsMd(workspace: string): void {
  const dest = agentsMdPath(workspace);
  if (!existsSync(dest)) return;
  const existing = readFileSync(dest, "utf8");
  const idx = managedMarkerIndex(existing);
  if (idx < 0) return;
  const before = existing.slice(0, idx).trimEnd();
  if (!before) {
    unlinkSync(dest);
    return;
  }
  writeFileSync(dest, `${before}\n`);
}
