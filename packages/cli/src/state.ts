/**
 * Small per-workspace state shared between hook runs (last prompt, last
 * memory capture time). Lives in ~/.fastpath/state.json — never in the repo.
 *
 * When Kiro provides session_id, turn fields (prompt / touched paths / handoff)
 * are stored under sessions[sessionId] so overlapping chats don't mislabel
 * memory. Workspace-level fields remain as a fallback for hooks without a
 * session id (e.g. some file-event payloads).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userFastpathDir } from './config.js';

export interface TurnState {
  lastPrompt?: string;
  lastPromptAt?: string;
  /** Files delta-indexed since the last memory capture (rolling, capped). */
  touchedPaths?: string[];
  /** Compact handoff note for the next agent/session. */
  contextSummary?: string;
  accessedFiles?: string[];
}

export interface WorkspaceState extends TurnState {
  lastCaptureAt?: string;
  sessions?: Record<string, TurnState>;
}

const MAX_TOUCHED_PATHS = 20;
const MAX_SESSIONS = 20;

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

/**
 * Effective turn state: session overlay wins over workspace fallbacks.
 */
export function readTurnState(workspace: string, sessionId = ''): WorkspaceState {
  const ws = readWorkspaceState(workspace);
  if (!sessionId) return ws;
  const sess = ws.sessions?.[sessionId];
  if (!sess) return ws;
  return {
    ...ws,
    lastPrompt: sess.lastPrompt ?? ws.lastPrompt,
    lastPromptAt: sess.lastPromptAt ?? ws.lastPromptAt,
    touchedPaths: sess.touchedPaths?.length ? sess.touchedPaths : ws.touchedPaths,
    contextSummary: sess.contextSummary ?? ws.contextSummary,
    accessedFiles: sess.accessedFiles?.length ? sess.accessedFiles : ws.accessedFiles,
  };
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

/**
 * Patch turn fields. With a session id, write the session overlay and mirror
 * lastPrompt / handoff to workspace so Stop/file hooks without session still
 * see the latest prompt.
 */
export function updateTurnState(
  workspace: string,
  sessionId: string,
  patch: Partial<TurnState>,
): void {
  const state = loadState();
  const key = resolve(workspace);
  const ws = { ...(state.workspaces[key] ?? {}) };

  if (!sessionId) {
    state.workspaces[key] = { ...ws, ...patch };
    saveState(state);
    return;
  }

  const sessions = { ...(ws.sessions ?? {}) };
  const prior = sessions[sessionId] ?? {};
  sessions[sessionId] = { ...prior, ...patch };

  // Cap session map size (drop oldest keys by insertion order approximation).
  const ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) {
      delete sessions[id];
    }
  }

  state.workspaces[key] = {
    ...ws,
    ...patch,
    sessions,
  };
  saveState(state);
}

export function recordTouchedPaths(
  workspace: string,
  paths: string[],
  sessionId = '',
): void {
  if (!paths.length) return;
  const current = readTurnState(workspace, sessionId).touchedPaths ?? [];
  const merged = [...new Set([...current, ...paths])].slice(-MAX_TOUCHED_PATHS);
  updateTurnState(workspace, sessionId, { touchedPaths: merged });
}

/** Clear touched paths after a successful memory capture. */
export function clearTouchedAfterCapture(workspace: string, sessionId = ''): void {
  updateTurnState(workspace, sessionId, { touchedPaths: [] });
  updateWorkspaceState(workspace, {
    lastCaptureAt: new Date().toISOString(),
  });
}
