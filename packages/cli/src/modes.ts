import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, saveConfig } from './config.js';

export const MODE_LEVELS = ['off', 'lite', 'full', 'ultra'] as const;
export type ModeLevel = (typeof MODE_LEVELS)[number];
export const MODE_KEYS = ['caveman', 'ponytail'] as const;
export type ModeKey = (typeof MODE_KEYS)[number];
export type ModeSettings = Record<ModeKey, ModeLevel>;
export type ModeSource = 'workspace' | 'global' | 'default';

export const DEFAULT_MODES: ModeSettings = { caveman: 'full', ponytail: 'full' };

export const MODE_RULES: Record<ModeKey, Record<Exclude<ModeLevel, 'off'>, string>> = {
  caveman: {
    lite: 'Keep articles and full sentences. Drop filler, pleasantries, hedging, tool narration.',
    full: 'Drop articles when meaning stays clear. Fragments OK. Short synonyms.',
    ultra:
      'Strip conjunctions when cause-then-effect stays unambiguous. One word when one word is enough.',
  },
  ponytail: {
    lite: 'Ladder is advisory. Small helpers allowed when they clarify. Ask before any new dependency.',
    full: 'Ladder is mandatory. No unrequested abstractions, dependencies, or boilerplate.',
    ultra:
      'One-line bias. No new file unless the change is impossible without it. Question every requirement before building.',
  },
};

export function isModeLevel(v: unknown): v is ModeLevel {
  return typeof v === 'string' && (MODE_LEVELS as readonly string[]).includes(v);
}

export function isModeKey(v: unknown): v is ModeKey {
  return typeof v === 'string' && (MODE_KEYS as readonly string[]).includes(v);
}

/** Absolute workspace key; realpath when the path exists (macOS /var vs /private/var). */
export function workspaceKey(workspace: string): string {
  const abs = resolve(workspace);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

function sanitizePartial(raw?: Partial<ModeSettings>): Partial<ModeSettings> {
  if (!raw) return {};
  const out: Partial<ModeSettings> = {};
  for (const key of MODE_KEYS) {
    if (isModeLevel(raw[key])) out[key] = raw[key];
  }
  return out;
}

export function resolveModes(workspace: string): {
  effective: ModeSettings;
  sources: Record<ModeKey, ModeSource>;
  workspace: Partial<ModeSettings>;
  global: Partial<ModeSettings>;
} {
  const cfg = loadConfig();
  const abs = workspaceKey(workspace);
  const global = sanitizePartial(cfg.modes);
  const workspaceModes = sanitizePartial(cfg.workspaces[abs]?.modes);
  const effective: ModeSettings = { ...DEFAULT_MODES };
  const sources: Record<ModeKey, ModeSource> = {
    caveman: 'default',
    ponytail: 'default',
  };
  for (const key of MODE_KEYS) {
    if (workspaceModes[key] !== undefined) {
      effective[key] = workspaceModes[key]!;
      sources[key] = 'workspace';
    } else if (global[key] !== undefined) {
      effective[key] = global[key]!;
      sources[key] = 'global';
    }
  }
  return { effective, sources, workspace: workspaceModes, global };
}

export function setModeLevel(
  scope: { workspace?: string },
  key: ModeKey,
  level: ModeLevel | 'inherit',
): void {
  if (!isModeKey(key)) throw new Error(`unknown key: ${key}`);
  if (level !== 'inherit' && !isModeLevel(level)) throw new Error(`unknown level: ${level}`);
  if (level === 'inherit' && !scope.workspace) {
    throw new Error('inherit not allowed at global scope');
  }

  const cfg = loadConfig();
  if (scope.workspace) {
    const abs = workspaceKey(scope.workspace);
    const entry = cfg.workspaces[abs] ?? { wiredAt: new Date().toISOString() };
    const modes: Partial<ModeSettings> = { ...(entry.modes ?? {}) };
    if (level === 'inherit') {
      delete modes[key];
    } else {
      modes[key] = level;
    }
    const next = { ...entry };
    if (Object.keys(modes).length === 0) {
      delete next.modes;
    } else {
      next.modes = modes;
    }
    cfg.workspaces[abs] = next;
  } else {
    const modes: Partial<ModeSettings> = { ...(cfg.modes ?? {}) };
    modes[key] = level as ModeLevel;
    cfg.modes = modes;
  }
  saveConfig(cfg);
}

export function renderModes(body: string, modes: ModeSettings): string {
  let out = body;
  for (const key of MODE_KEYS) {
    const level = modes[key];
    const open = `<!-- fastpath:mode:${key} -->`;
    const close = `<!-- /fastpath:mode:${key} -->`;
    if (level === 'off') {
      const blockRe = new RegExp(
        `${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}\\n?`,
        'g',
      );
      out = out.replace(blockRe, '');
    } else {
      out = out
        .replace(new RegExp(`${escapeRegExp(open)}\\n?`, 'g'), '')
        .replace(new RegExp(`${escapeRegExp(close)}\\n?`, 'g'), '');
    }
    const upper = key.toUpperCase();
    out = out.split(`__${upper}_LEVEL__`).join(level);
    const rule = level === 'off' ? '' : MODE_RULES[key][level];
    out = out.split(`__${upper}_RULE__`).join(rule);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
