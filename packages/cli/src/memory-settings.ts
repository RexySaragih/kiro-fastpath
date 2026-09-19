/**
 * Memory lifecycle settings — resolve/set in ~/.fastpath/config.json.
 */
import { setMemoryLimits } from '@fastpath/core';
import {
  loadConfig,
  saveConfig,
  type ConfigMemory,
} from './config.js';
import { workspaceKey } from './modes.js';

export type MemorySettings = {
  sessionMax: number;
  pruneAfterDays: number;
  pruneScoreFloor: number;
  recencyHalfLifeDays: number;
  autoPrune: boolean;
  recallTopK: number;
  sessionInjectCount: number;
  sessionInjectChars: number;
  capture: boolean;
};

export const DEFAULT_MEMORY: MemorySettings = {
  sessionMax: 50,
  pruneAfterDays: 60,
  pruneScoreFloor: 0.02,
  recencyHalfLifeDays: 30,
  autoPrune: true,
  recallTopK: 3,
  sessionInjectCount: 3,
  sessionInjectChars: 200,
  capture: true,
};

export const MEMORY_KEYS = [
  'sessionMax',
  'pruneAfterDays',
  'pruneScoreFloor',
  'recencyHalfLifeDays',
  'autoPrune',
  'recallTopK',
  'sessionInjectCount',
  'sessionInjectChars',
  'capture',
] as const;

export type MemoryKey = (typeof MEMORY_KEYS)[number];

export function isMemoryKey(v: unknown): v is MemoryKey {
  return typeof v === 'string' && (MEMORY_KEYS as readonly string[]).includes(v);
}

function sanitizeMemory(raw?: ConfigMemory): ConfigMemory {
  if (!raw || typeof raw !== 'object') return {};
  const out: ConfigMemory = {};
  for (const k of [
    'sessionMax',
    'pruneAfterDays',
    'recencyHalfLifeDays',
    'recallTopK',
    'sessionInjectCount',
    'sessionInjectChars',
  ] as const) {
    const n = raw[k];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  if (typeof raw.pruneScoreFloor === 'number' && Number.isFinite(raw.pruneScoreFloor) && raw.pruneScoreFloor >= 0) {
    out.pruneScoreFloor = raw.pruneScoreFloor;
  }
  if (typeof raw.autoPrune === 'boolean') out.autoPrune = raw.autoPrune;
  if (typeof raw.capture === 'boolean') out.capture = raw.capture;
  return out;
}

export function resolveMemory(workspace: string): {
  effective: MemorySettings;
  workspace: ConfigMemory;
  global: ConfigMemory;
} {
  const cfg = loadConfig();
  const abs = workspaceKey(workspace);
  const global = sanitizeMemory(cfg.memory);
  const workspaceMem = sanitizeMemory(cfg.workspaces[abs]?.memory);
  const effective: MemorySettings = {
    ...DEFAULT_MEMORY,
    ...global,
    ...workspaceMem,
  };
  return { effective, workspace: workspaceMem, global };
}

export function setMemorySetting(
  scope: { workspace?: string },
  key: MemoryKey,
  value: number | boolean | 'inherit',
): void {
  if (!isMemoryKey(key)) throw new Error(`unknown memory key: ${key}`);
  if (value === 'inherit' && !scope.workspace) {
    throw new Error('inherit not allowed at global scope');
  }

  const boolKeys: MemoryKey[] = ['autoPrune', 'capture'];
  if (value !== 'inherit') {
    if (boolKeys.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} expects boolean`);
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${key} expects a number`);
    }
  }

  const cfg = loadConfig();
  if (scope.workspace) {
    const abs = workspaceKey(scope.workspace);
    const entry = cfg.workspaces[abs] ?? { wiredAt: new Date().toISOString() };
    const memory: ConfigMemory = { ...(entry.memory ?? {}) };
    if (value === 'inherit') delete memory[key];
    else (memory as Record<string, number | boolean>)[key] = value;
    const next = { ...entry };
    if (Object.keys(memory).length === 0) delete next.memory;
    else next.memory = memory;
    cfg.workspaces[abs] = next;
  } else {
    const memory: ConfigMemory = { ...(cfg.memory ?? {}) };
    (memory as Record<string, number | boolean>)[key] = value as number | boolean;
    cfg.memory = memory;
  }
  saveConfig(cfg);
}

export function setMemoryPatch(
  scope: { workspace?: string },
  patch: ConfigMemory,
): void {
  const cfg = loadConfig();
  const clean = sanitizeMemory(patch);
  if (scope.workspace) {
    const abs = workspaceKey(scope.workspace);
    const entry = cfg.workspaces[abs] ?? { wiredAt: new Date().toISOString() };
    const memory = { ...(entry.memory ?? {}), ...clean };
    cfg.workspaces[abs] = { ...entry, memory };
  } else {
    cfg.memory = { ...(cfg.memory ?? {}), ...clean };
  }
  saveConfig(cfg);
}

/** Push resolved lifecycle caps into core for this process. */
export function applyMemoryLimits(workspace: string): MemorySettings {
  const { effective } = resolveMemory(workspace);
  setMemoryLimits({
    sessionMax: effective.sessionMax,
    pruneAfterDays: effective.pruneAfterDays,
    pruneScoreFloor: effective.pruneScoreFloor,
    recencyHalfLifeDays: effective.recencyHalfLifeDays,
    autoPrune: effective.autoPrune,
    recallTopK: effective.recallTopK,
  });
  return effective;
}
