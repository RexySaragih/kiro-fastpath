/**
 * Workspace-root AGENTS.md — Kiro Default agent always loads this file.
 * Managed by FastPath (marker <!-- fastpath:agents -->; legacy <!-- fastpath:caveman -->).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderModes, type ModeSettings } from "./modes.js";

export const AGENTS_MD_MARKER = "<!-- fastpath:agents -->";
/** Prior marker — still treated as FastPath-managed for refresh/remove. */
export const AGENTS_MD_MARKER_LEGACY = "<!-- fastpath:caveman -->";

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
 * - Missing → write body
 * - Ours (marker) → overwrite/refresh FastPath block from body
 * - Foreign (no marker) → append FastPath section once
 */
export function ensureAgentsMd(workspace: string, body: string): void {
  const dest = agentsMdPath(workspace);
  const content = body.endsWith("\n") ? body : `${body}\n`;

  if (!existsSync(dest)) {
    writeFileSync(dest, content);
    return;
  }

  const existing = readFileSync(dest, "utf8");
  const idx = managedMarkerIndex(existing);
  if (idx < 0) {
    writeFileSync(dest, `${existing.trimEnd()}\n\n${content}`);
    return;
  }
  const before = existing.slice(0, idx).trimEnd();
  if (!before) {
    writeFileSync(dest, content);
    return;
  }
  writeFileSync(dest, `${before}\n\n${content}`);
}

export function ensureAgentsMdFromPack(
  workspace: string,
  agentPackDir: string,
  modes: ModeSettings,
): void {
  const templatePath = join(agentPackDir, "AGENTS.md");
  if (!existsSync(templatePath)) return;
  const rendered = renderModes(readFileSync(templatePath, "utf8"), modes);
  ensureAgentsMd(workspace, rendered);
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
