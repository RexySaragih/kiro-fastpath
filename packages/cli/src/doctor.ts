import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDatabaseIntegrity,
  CURRENT_SCHEMA_VERSION,
  findDirtyFiles,
  getIndexStats,
  getMeta,
  getSchemaVersion,
  IndexLimits,
  lookupSymbol,
  minilmWeightsPresent,
  modelCacheDir,
  openDatabase,
  resolveDbPath,
  searchIndex,
} from '@fastpath/core';
import {
  PACKAGE_ROOT,
  readPackageVersion,
  resolveFastpathHome,
} from './config.js';
import { appendMetric, readMetrics } from './metrics.js';
import { readHeartbeats, type HookName } from './hook-util.js';

const coreRequire = createRequire(join(PACKAGE_ROOT, 'packages/core/package.json'));

const IDE_UNSUPPORTED_AGENT_FIELDS = ['allowedTools', 'includeMcpJson', 'toolsSettings'] as const;

/** Tool tags mistaken for permission capabilities (breaks Kiro agent-profile load). */
const INVALID_PERMISSION_CAPABILITIES = ['write', 'read', 'web'] as const;

export function findIdeUnsupportedAgentFields(body: string): string[] {
  return IDE_UNSUPPORTED_AGENT_FIELDS.filter((field) =>
    new RegExp(`\\b${field}\\b`).test(body),
  );
}

/** Detect `capability: write` etc. — must be fs_write / fs_read / shell / … */
export function findInvalidPermissionCapabilities(body: string): string[] {
  return INVALID_PERMISSION_CAPABILITIES.filter((cap) =>
    new RegExp(`capability:\\s*["']?${cap}["']?\\b`).test(body),
  );
}

/**
 * Hook `matcher` values are compiled as JS RegExp by the host. Inline flags
 * like `(?i)` are a syntax error there, so a bad matcher silently never fires.
 */
export function findInvalidHookMatchers(
  hooks: Array<{ name?: string; matcher?: string }>,
): string[] {
  const bad: string[] = [];
  for (const hook of hooks) {
    if (typeof hook.matcher !== 'string' || !hook.matcher) continue;
    const label = hook.name ?? 'unnamed hook';
    if (/\(\?[a-zA-Z]+\)/.test(hook.matcher)) {
      bad.push(`${label}: inline flags (e.g. \`(?i)\`) are invalid in JS RegExp`);
      continue;
    }
    try {
      new RegExp(hook.matcher);
    } catch (err) {
      bad.push(`${label}: ${err instanceof Error ? err.message : 'invalid regex'}`);
    }
  }
  return bad;
}

/** Hooks whose liveness we assert (7 event hooks → 7 heartbeats). */
const LIVENESS_HOOKS: HookName[] = [
  'prompt-inject',
  'session-start',
  'file-save',
  'file-create',
  'file-delete',
  'memory-capture',
  'guardrail',
];
const LIVENESS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface HookLiveness {
  verified: boolean;
  fired: string[];
  never: string[];
  stale: string[];
}

/** Disk presence is not proof of function — require a recent heartbeat. */
export function checkHookLiveness(now = Date.now()): HookLiveness {
  const beats = readHeartbeats().hooks;
  const fired: string[] = [];
  const never: string[] = [];
  const stale: string[] = [];
  for (const hook of LIVENESS_HOOKS) {
    const beat = beats[hook];
    if (!beat) {
      never.push(hook);
      continue;
    }
    const age = now - Date.parse(beat.lastAt);
    if (Number.isNaN(age) || age > LIVENESS_MAX_AGE_MS) stale.push(hook);
    else fired.push(hook);
  }
  return { verified: never.length === 0 && stale.length === 0, fired, never, stale };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function assertBuiltArtifacts(root = PACKAGE_ROOT): string[] {
  const missing: string[] = [];
  const mcpServerPath = join(root, 'packages/mcp-server/dist/index.js');
  if (!existsSync(mcpServerPath)) {
    missing.push(`MCP server missing: ${mcpServerPath} (npm run build)`);
  }
  const hookScripts = [
    'prompt-inject.js',
    'session-start.js',
    'file-event.js',
    'guardrail.js',
    'memory-capture.js',
  ];
  for (const script of hookScripts) {
    const p = join(root, 'packages/cli/dist', script);
    if (!existsSync(p)) missing.push(`hook script missing: ${p} (npm run build)`);
  }
  return missing;
}

function checkNativeModules(issues: string[], ok: string[]): void {
  const mods = ['better-sqlite3'];
  for (const name of mods) {
    try {
      coreRequire(name);
      ok.push(`Native load OK: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NODE_MODULE_VERSION|was compiled against/i.test(msg)) {
        issues.push(
          `${name} ABI mismatch (Node upgraded?) — run \`fastpath repair-native\``,
        );
      } else {
        issues.push(`${name} failed to load — run \`fastpath repair-native\` (${msg})`);
      }
    }
  }
}

function checkAgentFile(
  label: string,
  path: string,
  issues: string[],
  ok: string[],
): void {
  if (!existsSync(path)) {
    issues.push(`${label} agent missing — run \`fastpath install-kiro\``);
    return;
  }
  const body = readFileSync(path, 'utf8');
  ok.push(`${label} agent installed`);
  if (!body.includes('@fastpath')) {
    issues.push(`${label} missing \`@fastpath\` in tools — re-run \`fastpath install-kiro\``);
  } else {
    ok.push(`${label} tools bind @fastpath`);
  }
  if (!body.includes('mcpServers:') && !body.includes('"mcpServers"')) {
    issues.push(`${label} missing inline mcpServers — re-run \`fastpath install-kiro\``);
  } else {
    ok.push(`${label} has inline mcpServers`);
  }
  if (body.includes('__FASTPATH_')) {
    issues.push(`${label} still has unresolved placeholders — re-run \`fastpath install-kiro\``);
  }
  if (!body.includes('FASTPATH_HOME')) {
    issues.push(
      `${label} missing FASTPATH_HOME in mcp env — re-run \`fastpath install-kiro\` (path hardening)`,
    );
  } else {
    ok.push(`${label} sets FASTPATH_HOME`);
  }
  const badCaps = findInvalidPermissionCapabilities(body);
  if (badCaps.length) {
    issues.push(
      `${label} has invalid permission capability (${badCaps.join(', ')}) — use fs_write/fs_read/shell; re-run \`fastpath install-kiro\``,
    );
  }
}

function extractQuotedPaths(command: string): string[] {
  const out: string[] = [];
  const re = /'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const raw = m[1] ?? m[2] ?? '';
    out.push(raw.replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return out;
}

export interface DoctorResult {
  ready: boolean;
  issues: string[];
  ok: string[];
  notes: string[];
  stats: ReturnType<typeof getIndexStats>;
  embedBackend: string;
  agentsIdeCompatible: boolean;
  hookEnabled: boolean;
  schemaVersion: number;
  integrityOk: boolean | null;
  searchSmokeOk: boolean | null;
  hookLiveness: HookLiveness;
  version: string;
  home: string;
  workspace: string;
}

export async function runDoctor(workspace: string): Promise<DoctorResult> {
  const issues: string[] = [];
  const ok: string[] = [];
  const notes: string[] = [];
  const dbPath = resolveDbPath(workspace);
  const stats = getIndexStats(workspace);
  let embedBackend = 'unknown';
  let agentsIdeCompatible = false;
  let hookEnabled = false;
  let schemaVersion = 0;
  let integrityOk: boolean | null = null;
  let searchSmokeOk: boolean | null = null;
  const home = resolveFastpathHome();

  for (const miss of assertBuiltArtifacts()) issues.push(miss);
  checkNativeModules(issues, ok);

  if (!existsSync(dbPath)) {
    issues.push('Index DB missing — run `fastpath index`');
  } else if (stats.files === 0) {
    issues.push('Index empty — run `fastpath index`');
  } else {
    ok.push(`Index ready: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges`);
  }

  const warnFiles = Number(process.env.FASTPATH_WARN_FILES) || IndexLimits.WARN_FILE_COUNT;
  if (stats.files > warnFiles) {
    notes.push(
      `Large index (${stats.files} files > ${warnFiles}) — delta inject caps at ${IndexLimits.DELTA_MAX_FILES} dirty files; prefer \`fastpath watch\``,
    );
  }

  if (existsSync(dbPath)) {
    try {
      const db = openDatabase(dbPath, { create: false });
      try {
        schemaVersion = getSchemaVersion(db);
        if (schemaVersion === 0) {
          issues.push('schema_version missing — run `fastpath index --rebuild`');
        } else if (schemaVersion > CURRENT_SCHEMA_VERSION) {
          issues.push(
            `schema_version=${schemaVersion} newer than CLI (${CURRENT_SCHEMA_VERSION}) — upgrade FastPath home`,
          );
        } else if (schemaVersion < CURRENT_SCHEMA_VERSION) {
          issues.push(
            `schema_version=${schemaVersion} < ${CURRENT_SCHEMA_VERSION} — run \`fastpath index --rebuild\``,
          );
        } else {
          ok.push(`Schema version ${schemaVersion}`);
        }

        const integrity = checkDatabaseIntegrity(db);
        integrityOk = integrity.ok;
        if (!integrity.ok) {
          issues.push(
            `DB integrity_check failed (${integrity.detail}) — run \`fastpath index --rebuild\``,
          );
        } else {
          ok.push('DB integrity_check ok');
        }

        const ngrams = (db.prepare(`SELECT COUNT(*) AS c FROM ngrams`).get() as { c: number }).c;
        const vectors = (db.prepare(`SELECT COUNT(*) AS c FROM symbol_vectors`).get() as {
          c: number;
        }).c;
        const lsh = (db.prepare(`SELECT COUNT(*) AS c FROM vector_lsh`).get() as {
          c: number;
        }).c;
        const backend = getMeta(db, 'embed_backend') ?? 'unknown';
        embedBackend = backend;
        const ann = getMeta(db, 'ann_backend') ?? 'unknown';
        const calls = (db.prepare(`SELECT COUNT(*) AS c FROM call_edges`).get() as {
          c: number;
        }).c;
        if (stats.files > 0 && ngrams === 0) {
          issues.push('N-gram index empty — re-run `fastpath index`');
        } else if (ngrams > 0) ok.push(`N-grams: ${ngrams}`);
        if (stats.symbols > 0 && vectors === 0) {
          issues.push('Symbol vectors missing — re-run `fastpath index`');
        } else if (vectors > 0) ok.push(`Vectors: ${vectors} (backend=${backend})`);
        if (vectors > 0 && lsh === 0) {
          issues.push('LSH ANN empty — re-run `fastpath index`');
        } else if (lsh > 0) ok.push(`ANN: ${ann} lsh_rows=${lsh}`);
        ok.push(`Call graph table ready (${calls} edges)`);
        if (backend === 'hash') {
          if (process.env.FASTPATH_ALLOW_HASH === '1') {
            ok.push('Embed backend=hash (allowed via FASTPATH_ALLOW_HASH=1)');
          } else {
            issues.push(
              'Embed backend=hash — run `fastpath warm` then `FASTPATH_EMBED=minilm fastpath index` (or FASTPATH_ALLOW_HASH=1)',
            );
          }
        } else if (backend === 'minilm') {
          ok.push('Embed backend=minilm');
        }
        ok.push('Watch recommended for long sessions: `fastpath watch`');
      } finally {
        db.close();
      }
    } catch {
      issues.push('Could not open index DB details');
    }
  }

  if (minilmWeightsPresent()) {
    ok.push(`MiniLM weights present (${modelCacheDir()})`);
  } else if (process.env.FASTPATH_ALLOW_HASH === '1') {
    notes.push(`MiniLM weights not in cache (${modelCacheDir()}) — ok with FASTPATH_ALLOW_HASH=1`);
  } else {
    notes.push(`MiniLM weights not cached yet — run \`fastpath warm\` (${modelCacheDir()})`);
  }

  if (stats.files > 0) {
    try {
      const dirtyCap = IndexLimits.DELTA_MAX_FILES;
      const dirty = findDirtyFiles(workspace, dirtyCap);
      if (dirty.length >= dirtyCap) {
        notes.push(
          `${dirty.length}+ dirty files — inject only reindexes ${IndexLimits.DELTA_MAX_FILES}; run \`fastpath index --git\` or watch`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  const steeringDir = join(workspace, '.kiro/steering');
  if (existsSync(steeringDir)) {
    let total = 0;
    for (const p of listMarkdownFiles(steeringDir)) {
      total += estimateTokens(readFileSync(p, 'utf8'));
    }
    if (total > 4000) issues.push(`Steering ~${total} tokens (prefer <4000 always-on)`);
    else ok.push(`Steering ~${total} tokens`);
  } else {
    ok.push('No .kiro/steering (ok)');
  }

  if (existsSync(join(workspace, '.kiro/specs'))) {
    issues.push('.kiro/specs present — archive completed specs to avoid auto-load bloat');
  } else {
    ok.push('No .kiro/specs bloat detected');
  }

  const agentsDir = join(workspace, '.kiro/agents');
  checkAgentFile('Scout', join(agentsDir, 'Scout.md'), issues, ok);
  checkAgentFile('Architect', join(agentsDir, 'Architect.md'), issues, ok);

  for (const legacy of ['Marshal.md', 'Router.md'] as const) {
    if (existsSync(join(agentsDir, legacy))) {
      notes.push(`Legacy ${legacy} still present — re-run install-kiro/rewire to remove it`);
    }
  }

  // Dual Scout sources drift — JSON is CLI-legacy; IDE uses .md
  const scoutJson = join(agentsDir, 'Scout.json');
  if (existsSync(scoutJson)) {
    notes.push(
      'Scout.json present (legacy) — IDE uses Scout.md; remove Scout.json or re-run install-kiro',
    );
  }

  if (existsSync(agentsDir)) {
    const agentFiles = readdirSync(agentsDir).filter(
      (n) => n.endsWith('.md') || n.endsWith('.json'),
    );
    let ideOk = true;
    for (const name of agentFiles) {
      const bad = findIdeUnsupportedAgentFields(
        readFileSync(join(agentsDir, name), 'utf8'),
      );
      if (bad.length) {
        ideOk = false;
        issues.push(
          `${name} has IDE-unsupported fields (${bad.join(', ')}) — agent hidden in IDE; re-run \`fastpath install-kiro\``,
        );
      }
    }
    if (ideOk && agentFiles.length) {
      agentsIdeCompatible = true;
      ok.push(`Agent pack IDE-compatible (${agentFiles.length} files)`);
    }
  }

  notes.push(
    'Workspace trust: Kiro only loads .kiro/agents when the workspace is trusted (product UI).',
  );
  notes.push(
    'Hook UI enable is unverifiable from disk — confirm fastpath-auto-context is ON in Kiro Hook UI.',
  );
  notes.push(
    'Effort is session-level in Kiro (not per-agent) — Scout: /effort low · Architect: /effort medium.',
  );

  const hookPath = join(workspace, '.kiro/hooks/fastpath-context.json');
  if (existsSync(hookPath)) {
    const hookBody = readFileSync(hookPath, 'utf8');
    if (hookBody.includes('__FASTPATH_')) {
      issues.push('hook placeholders unresolved — re-run `fastpath install-kiro`');
    } else {
      try {
        const hookJson = JSON.parse(hookBody) as {
          hooks?: Array<{
            name?: string;
            trigger?: string;
            matcher?: string;
            action?: { command?: string };
            enabled?: boolean;
          }>;
        };

        const badMatchers = findInvalidHookMatchers(hookJson.hooks ?? []);
        if (badMatchers.length) {
          for (const bad of badMatchers) {
            issues.push(`hook matcher never compiles — ${bad} (re-run \`fastpath install-kiro\`)`);
          }
        } else {
          ok.push('Hook matchers compile as JS RegExp');
        }
        const inject = hookJson.hooks?.find((h) => h.trigger === 'UserPromptSubmit');
        if (!inject) {
          issues.push('fastpath hook missing UserPromptSubmit trigger');
        } else if (inject.enabled === false) {
          issues.push('fastpath-auto-context hook is disabled — enable in Kiro Hook UI');
        } else if (!inject.action?.command?.includes('prompt-inject')) {
          issues.push('UserPromptSubmit hook command does not point at prompt-inject');
        } else {
          const cmd = inject.action.command ?? '';
          const paths = extractQuotedPaths(cmd);
          const injectPath =
            paths.find((p) => p.includes('prompt-inject')) ||
            join(home, 'packages/cli/dist/prompt-inject.js');
          if (!existsSync(injectPath) && !cmd.includes('prompt-inject')) {
            issues.push(`hook inject script missing: ${injectPath}`);
          } else if (paths.some((p) => p.includes('prompt-inject') && !existsSync(p))) {
            const missing = paths.find((p) => p.includes('prompt-inject') && !existsSync(p));
            issues.push(`hook inject script missing: ${missing} — re-run install-kiro`);
          } else {
            ok.push('Hook inject script path resolves');
          }
          if (!cmd.includes('FASTPATH_HOME') && !cmd.includes(home)) {
            notes.push('Hook command missing FASTPATH_HOME — re-run install-kiro for path hardening');
          }
          hookEnabled = true;
          ok.push('UserPromptSubmit auto-inject hook installed');
        }

        const eventTriggers = [
          'SessionStart',
          'PostFileSave',
          'PostFileCreate',
          'PostFileDelete',
          'PreToolUse',
          'Stop',
        ];
        const present = eventTriggers.filter((t) =>
          hookJson.hooks?.some((h) => h.trigger === t),
        );
        if (present.length === eventTriggers.length) {
          ok.push('Event hooks installed (session-start, file delta, guardrail)');
        } else {
          const missing = eventTriggers.filter((t) => !present.includes(t));
          notes.push(
            `Event hooks missing (${missing.join(', ')}) — re-run \`fastpath install-kiro\` for save-time freshness + guardrail`,
          );
        }
      } catch {
        issues.push('fastpath-context.json is not valid JSON');
      }
    }
  } else {
    issues.push(
      'auto-inject hook missing — run `fastpath install-kiro` (index alone will not be used)',
    );
  }

  const mcpPath = join(workspace, '.kiro/settings/mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers?: Record<
          string,
          { disabled?: boolean; args?: string[]; env?: Record<string, string> }
        >;
      };
      const servers = mcp.mcpServers ?? {};
      const enabled = Object.entries(servers).filter(([, v]) => !v?.disabled);
      if (enabled.length > 3) {
        issues.push(`${enabled.length} MCP servers enabled — keep FastPath-only for Scout speed`);
      } else {
        ok.push(`MCP servers enabled: ${enabled.length}`);
      }
      const fp = servers.fastpath;
      if (!fp || fp.disabled) {
        issues.push('fastpath MCP missing/disabled in mcp.json');
      } else {
        ok.push('fastpath MCP configured');
        const argPath = fp.args?.[0];
        if (argPath && !existsSync(argPath)) {
          issues.push(`MCP server script missing: ${argPath} — rebuild or re-run install-kiro`);
        } else if (argPath) {
          ok.push('MCP server script path resolves');
        }
        if (fp.env?.FASTPATH_HOME && resolveFastpathHome() !== fp.env.FASTPATH_HOME) {
          notes.push(
            `mcp.json FASTPATH_HOME (${fp.env.FASTPATH_HOME}) ≠ current home (${home}) — re-run use/install-kiro`,
          );
        }
      }
    } catch {
      issues.push('mcp.json unreadable');
    }
  } else {
    issues.push('mcp.json missing — run `fastpath install-kiro`');
  }

  // Runtime search smoke (same path agents use via MCP tools)
  if (stats.files > 0 && issues.every((i) => !i.includes('Index'))) {
    try {
      const hits = await searchIndex(workspace, 'function', { topK: 2 });
      const symbols = lookupSymbol(workspace, 'a', { topK: 1 });
      searchSmokeOk = hits.length > 0 || symbols.length > 0;
      if (searchSmokeOk) {
        ok.push(
          `Search smoke OK (${hits.length} search hit(s), ${symbols.length} symbol hit(s))`,
        );
      } else {
        issues.push(
          'Search smoke returned no results despite non-empty index — try `fastpath index --rebuild`',
        );
      }
    } catch (err) {
      searchSmokeOk = false;
      issues.push(
        `Search smoke failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const injects = readMetrics(200).filter(
    (e): e is Extract<typeof e, { type: 'inject' }> => e.type === 'inject',
  );
  if (injects.length >= IndexLimits.INJECT_HIT_RATE_MIN_SAMPLES) {
    const withHits = injects.filter((i) => i.hits > 0).length;
    const rate = withHits / injects.length;
    const timeouts = injects.filter((i) => i.timedOutDelta || i.timedOutRetrieve).length;
    if (rate < IndexLimits.INJECT_HIT_RATE_FLOOR) {
      notes.push(
        `Inject hitRate=${(rate * 100).toFixed(0)}% over ${injects.length} samples — index may be stale; run \`fastpath index\``,
      );
    } else {
      ok.push(`Inject hitRate=${(rate * 100).toFixed(0)}% (n=${injects.length})`);
    }
    if (timeouts > injects.length / 2) {
      notes.push(
        `Inject timeouts high (${timeouts}/${injects.length}) — prefer \`fastpath watch\` or raise budgets`,
      );
    }
  }

  const hookLiveness = checkHookLiveness();
  if (hookLiveness.fired.length) {
    ok.push(`Hooks fired recently: ${hookLiveness.fired.join(', ')}`);
  }
  if (hookLiveness.never.length) {
    notes.push(
      `Hooks never fired: ${hookLiveness.never.join(', ')} — enable them in the Kiro Hook UI, then re-run doctor (FASTPATH_HOOK_DEBUG=1 to capture payloads)`,
    );
  }
  if (hookLiveness.stale.length) {
    notes.push(`Hooks stale (>14d): ${hookLiveness.stale.join(', ')}`);
  }

  const ready = issues.length === 0;
  appendMetric({
    type: 'doctor',
    at: new Date().toISOString(),
    ready,
    issueCount: issues.length,
  });

  return {
    ready,
    issues,
    ok,
    notes,
    stats,
    embedBackend,
    agentsIdeCompatible,
    hookEnabled,
    schemaVersion,
    integrityOk,
    searchSmokeOk,
    hookLiveness,
    version: readPackageVersion(),
    home,
    workspace,
  };
}

export function printDoctor(result: DoctorResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`# fastpath doctor — ${result.workspace}\n`);
  for (const line of result.ok) console.log(`OK  ${line}`);
  for (const line of result.notes) console.log(`..  ${line}`);
  for (const line of result.issues) console.log(`!!  ${line}`);
  if (result.ready && !result.hookLiveness.verified) {
    const missing = [...result.hookLiveness.never, ...result.hookLiveness.stale];
    console.log('\nUNVERIFIED — install looks correct but these hooks have not fired:');
    console.log(`  ${missing.join(', ')}`);
    console.log('Enable them in the Kiro Hook UI, run one prompt, then re-run doctor.');
  } else if (result.ready) {
    console.log('\nSCOUT READY');
    console.log('In Kiro: select agent "Scout". Hook liveness verified by heartbeat.');
  } else {
    console.log(`\nNOT READY (${result.issues.length} issue(s))`);
  }
}
