import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo root when running from packages/cli/dist */
export const PACKAGE_ROOT = resolve(__dirname, '../../..');

export type ConfigModeLevel = 'off' | 'lite' | 'full' | 'ultra';
export type ConfigModeSettings = Partial<
  Record<'caveman' | 'ponytail', ConfigModeLevel>
>;

export interface WorkspaceEntry {
  wiredAt: string;
  modes?: ConfigModeSettings;
}

export interface FastpathConfig {
  home: string;
  version: string;
  modes?: ConfigModeSettings;
  workspaces: Record<string, WorkspaceEntry>;
  lastWorkspace: string | null;
}

/** Default clone/install dir — matches git repo name `kiro-fastpath`. */
export function defaultFastpathHome(): string {
  const env = process.env.FASTPATH_HOME?.trim();
  if (env) return resolve(env);
  return join(homedir(), 'kiro-fastpath');
}

export function resolveFastpathHome(): string {
  const preferred = defaultFastpathHome();
  if (existsSync(join(preferred, 'packages/cli/dist/index.js'))) return preferred;
  // Legacy default from early 0.3 installs
  const legacy = join(homedir(), 'fastpath');
  if (existsSync(join(legacy, 'packages/cli/dist/index.js'))) return legacy;
  // Dev checkout: use package root if it looks like FastPath
  if (existsSync(join(PACKAGE_ROOT, 'packages/cli/dist/index.js'))) return PACKAGE_ROOT;
  return preferred;
}

export function userFastpathDir(): string {
  // Overridable for tests and sandboxed environments.
  return process.env.FASTPATH_USER_DIR?.trim() || join(homedir(), '.fastpath');
}

export function configPath(): string {
  return join(userFastpathDir(), 'config.json');
}

export function metricsPath(): string {
  return join(userFastpathDir(), 'metrics.jsonl');
}

export function readPackageVersion(home = resolveFastpathHome()): string {
  try {
    const pkg = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(): FastpathConfig {
  const path = configPath();
  const home = resolveFastpathHome();
  const version = readPackageVersion(home);
  if (!existsSync(path)) {
    return { home, version, workspaces: {}, lastWorkspace: null };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FastpathConfig>;
    return {
      home: raw.home ?? home,
      version: raw.version ?? version,
      ...(raw.modes ? { modes: raw.modes } : {}),
      workspaces: raw.workspaces ?? {},
      lastWorkspace: raw.lastWorkspace ?? null,
    };
  } catch {
    return { home, version, workspaces: {}, lastWorkspace: null };
  }
}

export function saveConfig(cfg: FastpathConfig): void {
  mkdirSync(userFastpathDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function recordWorkspaceWired(workspace: string): void {
  const cfg = loadConfig();
  cfg.home = resolveFastpathHome();
  cfg.version = readPackageVersion(cfg.home);
  const key = resolve(workspace);
  let abs = key;
  try {
    if (existsSync(key)) abs = realpathSync(key);
  } catch {
    /* keep resolve() key */
  }
  const prev = cfg.workspaces[abs] ?? cfg.workspaces[key];
  if (prev && abs !== key) delete cfg.workspaces[key];
  cfg.workspaces[abs] = {
    wiredAt: new Date().toISOString(),
    ...(prev?.modes ? { modes: prev.modes } : {}),
  };
  cfg.lastWorkspace = abs;
  saveConfig(cfg);
}

export function listWiredWorkspaces(): string[] {
  return Object.keys(loadConfig().workspaces).sort();
}

export function unrecordWorkspace(workspace: string): void {
  const cfg = loadConfig();
  const key = resolve(workspace);
  delete cfg.workspaces[key];
  if (cfg.lastWorkspace === key) {
    const remaining = Object.keys(cfg.workspaces);
    cfg.lastWorkspace = remaining[0] ?? null;
  }
  saveConfig(cfg);
}
