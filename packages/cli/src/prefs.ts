/**
 * Agent prefs: inject pack size + effort reminders (not Kiro-bound effort).
 */
import { loadConfig, saveConfig, type ConfigPrefs, type EffortLevel } from './config.js';
import { workspaceKey } from './modes.js';

export type EffortReminders = { scout: EffortLevel; architect: EffortLevel };
export type InjectPrefs = { maxHits: number; contextChunks: number; tokenBudget: number };
export type PrefsSettings = {
  inject: InjectPrefs;
  effortReminders: EffortReminders;
};

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export const DEFAULT_PREFS: PrefsSettings = {
  inject: { maxHits: 4, contextChunks: 4, tokenBudget: 1400 },
  effortReminders: { scout: 'low', architect: 'medium' },
};

export const MODE_PRESETS: Record<
  string,
  { caveman: 'off' | 'lite' | 'full' | 'ultra'; ponytail: 'off' | 'lite' | 'full' | 'ultra'; label: string }
> = {
  quiet: { caveman: 'ultra', ponytail: 'ultra', label: 'Quiet + lazy (ultra/ultra)' },
  balanced: { caveman: 'full', ponytail: 'full', label: 'Balanced (full/full)' },
  strict: { caveman: 'lite', ponytail: 'ultra', label: 'Clear talk + strict code' },
};

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

function sanitizePrefs(raw?: ConfigPrefs): ConfigPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const out: ConfigPrefs = {};
  if (raw.inject && typeof raw.inject === 'object') {
    const inj: ConfigPrefs['inject'] = {};
    for (const k of ['maxHits', 'contextChunks', 'tokenBudget'] as const) {
      const n = raw.inject[k];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) inj[k] = Math.floor(n);
    }
    if (Object.keys(inj).length) out.inject = inj;
  }
  if (raw.effortReminders && typeof raw.effortReminders === 'object') {
    const er: NonNullable<ConfigPrefs['effortReminders']> = {};
    if (isEffortLevel(raw.effortReminders.scout)) er.scout = raw.effortReminders.scout;
    if (isEffortLevel(raw.effortReminders.architect)) er.architect = raw.effortReminders.architect;
    if (Object.keys(er).length) out.effortReminders = er;
  }
  return out;
}

function mergePrefs(base: PrefsSettings, overlay: ConfigPrefs): PrefsSettings {
  return {
    inject: { ...base.inject, ...(overlay.inject ?? {}) },
    effortReminders: { ...base.effortReminders, ...(overlay.effortReminders ?? {}) },
  };
}

export function resolvePrefs(workspace: string): {
  effective: PrefsSettings;
  workspace: ConfigPrefs;
  global: ConfigPrefs;
} {
  const cfg = loadConfig();
  const abs = workspaceKey(workspace);
  const global = sanitizePrefs(cfg.prefs);
  const workspacePrefs = sanitizePrefs(cfg.workspaces[abs]?.prefs);
  const effective = mergePrefs(mergePrefs(DEFAULT_PREFS, global), workspacePrefs);
  return { effective, workspace: workspacePrefs, global };
}

/** Patch prefs at workspace or global scope. `inherit` clears a top-level key (inject|effortReminders). */
export function setPrefs(
  scope: { workspace?: string },
  patch: ConfigPrefs | { inherit: 'inject' | 'effortReminders' | 'all' },
): void {
  const cfg = loadConfig();
  if (scope.workspace) {
    const abs = workspaceKey(scope.workspace);
    const entry = cfg.workspaces[abs] ?? { wiredAt: new Date().toISOString() };
    let prefs: ConfigPrefs = { ...(entry.prefs ?? {}) };
    if ('inherit' in patch) {
      if (patch.inherit === 'all') prefs = {};
      else delete prefs[patch.inherit];
    } else {
      prefs = {
        ...prefs,
        ...(patch.inject ? { inject: { ...prefs.inject, ...patch.inject } } : {}),
        ...(patch.effortReminders
          ? { effortReminders: { ...prefs.effortReminders, ...patch.effortReminders } }
          : {}),
      };
    }
    const next = { ...entry };
    if (Object.keys(prefs).length === 0) delete next.prefs;
    else next.prefs = prefs;
    cfg.workspaces[abs] = next;
  } else {
    if ('inherit' in patch) {
      throw new Error('inherit not allowed at global scope');
    }
    cfg.prefs = {
      ...(cfg.prefs ?? {}),
      ...(patch.inject ? { inject: { ...(cfg.prefs?.inject ?? {}), ...patch.inject } } : {}),
      ...(patch.effortReminders
        ? {
            effortReminders: {
              ...(cfg.prefs?.effortReminders ?? {}),
              ...patch.effortReminders,
            },
          }
        : {}),
    };
  }
  saveConfig(cfg);
}

export function resetModes(
  scope: { workspace?: string; global?: boolean },
): void {
  const cfg = loadConfig();
  if (scope.global) {
    delete cfg.modes;
  }
  if (scope.workspace) {
    const abs = workspaceKey(scope.workspace);
    const entry = cfg.workspaces[abs];
    if (entry) {
      delete entry.modes;
      cfg.workspaces[abs] = entry;
    }
  }
  saveConfig(cfg);
}
