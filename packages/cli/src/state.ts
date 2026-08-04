/**
 * Small per-workspace state shared between hook runs (last prompt, last
 * memory capture time). Lives in ~/.fastpath/state.json — never in the repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userFastpathDir } from './config.js';

export interface WorkspaceState {
  lastPrompt?: string;
  lastPromptAt?: string;
  lastCaptureAt?: string;
  /** Files delta-indexed since the last memory capture (rolling, capped). */
  touchedPaths?: string[];
}

const MAX_TOUCHED_PATHS = 20;

interface StateFile {
  workspaces: Record<string, WorkspaceState>;
}

function statePath(): string {
  return join(userFastpathDir(), 'state.json');
}

function loadState(): StateFile {
  try {
    if (!existsSync(statePath())) return { workspaces: {} };
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<StateFile>;
    return { workspaces: raw.workspaces ?? {} };
  } catch {
    return { workspaces: {} };
  }
}

function saveState(state: StateFile): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* hooks must never fail on state */
  }
}

export function readWorkspaceState(workspace: string): WorkspaceState {
  return loadState().workspaces[resolve(workspace)] ?? {};
}

export function updateWorkspaceState(
  workspace: string,
  patch: Partial<WorkspaceState>,
): void {
  const state = loadState();
  const key = resolve(workspace);
  state.workspaces[key] = { ...(state.workspaces[key] ?? {}), ...patch };
  saveState(state);
}

export function recordTouchedPaths(workspace: string, paths: string[]): void {
  if (!paths.length) return;
  const current = readWorkspaceState(workspace).touchedPaths ?? [];
  const merged = [...new Set([...current, ...paths])].slice(-MAX_TOUCHED_PATHS);
  updateWorkspaceState(workspace, { touchedPaths: merged });
}
