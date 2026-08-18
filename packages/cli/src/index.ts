#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  distillMemories,
  forgetMemory,
  getIndexStats,
  indexGitChanged,
  indexWorkspace,
  listMemories,
  McpTimeouts,
  resolveDbPath,
  watchWorkspace,
  warmEmbedder,
  warmParsers,
  warmReranker,
} from '@fastpath/core';
import {
  ensureAgentsMdFromPack,
  removeManagedAgentsMd,
} from './agents-md.js';
import {
  listWiredWorkspaces,
  loadConfig,
  PACKAGE_ROOT,
  readPackageVersion,
  recordWorkspaceWired,
  resolveFastpathHome,
  saveConfig,
  unrecordWorkspace,
} from './config.js';
import {
  assertBuiltArtifacts,
  findIdeUnsupportedAgentFields,
  findInvalidPermissionCapabilities,
  printDoctor,
  runDoctor,
} from './doctor.js';
import { runBuiltinEval } from './eval.js';
import { appendMetric, readMetrics, summarizeMetrics, tokenLedger } from './metrics.js';
import { runViz } from './viz.js';

const ROOT = PACKAGE_ROOT;
const AGENT_PACK = join(ROOT, 'packages/agent-pack');

/** IDE agents only — Scout.json removed (dual-source drift). */
const AGENT_TEMPLATES = ['Scout.md', 'Architect.md'] as const;

function usage(): never {
  const ver = readPackageVersion();
  console.log(`fastpath — Kiro Fast-Path CLI v${ver}

Usage:
  fastpath init [workspace]              Create .fastpath/ + ignore starter
  fastpath index [workspace] [--git|--rebuild]
  fastpath watch [workspace]             Path-delta re-index on file changes
  fastpath status [workspace]            Show index stats
  fastpath doctor [workspace] [--json]
  fastpath warm                          Download MiniLM + reranker + grammars
  fastpath eval [--office|--golden]      Retrieval eval (smoke, office, or graded golden set)
  fastpath bench [ws] [--tasks f.json]   Token benchmark: injected vs baseline discovery cost
  fastpath install-kiro|repair-kiro|use [workspace]
  fastpath rewire [--all] [workspace]    Re-run install-kiro (path refresh)
  fastpath unwire [workspace] [--purge-index]
  fastpath upgrade [--from <checkout>] [--rewire]
                                   Sync/build FASTPATH_HOME; --from when home has no .git
  fastpath repair-native                 Rebuild better-sqlite3 / onnx / sharp
  fastpath home|version|metrics [--summary|--tokens]
  fastpath memory list|forget <id>|distill [workspace]
  fastpath viz [workspace] [--no-open] [--out file.html]  # HTML report: this project + all FastPath

Env:
  FASTPATH_HOME        Install root (default ~/kiro-fastpath)
  FASTPATH_WORKSPACE   Default workspace (else cwd)
  FASTPATH_EMBED       auto|minilm|hash (default auto → MiniLM)
  FASTPATH_RERANK      on|off (default on with minilm)
  FASTPATH_PARSER      treesitter|legacy
  FASTPATH_ALLOW_HASH  1 to allow hash backend in doctor
`);
  process.exit(1);
}

function takeFlag(args: string[], flag: string): { args: string[]; set: boolean } {
  const set = args.includes(flag);
  return { args: args.filter((a) => a !== flag), set };
}

function workspaceFromArgs(args: string[]): string {
  const positional = args.filter((a) => !a.startsWith('--'));
  return resolve(positional[0] || process.env.FASTPATH_WORKSPACE || process.cwd());
}

function printKiroChecklist(): void {
  console.log('');
  console.log('Kiro checklist:');
  console.log('  1) Reload window (Cmd+Shift+P → Developer: Reload Window)');
  console.log('  2) Trust workspace if prompted (required for .kiro/agents)');
  console.log('  3) Default agent is primary; spawn Scout to gather · Architect 6+ when needed');
  console.log('  4) Hook UI → enable all fastpath-* hooks');
  console.log('  5) Effort: Scout → /effort low · Architect → /effort medium');
}

function cmdInit(workspace: string): void {
  const dir = join(workspace, '.fastpath');
  mkdirSync(dir, { recursive: true });
  const ignorePath = join(workspace, '.fastpathignore');
  if (!existsSync(ignorePath)) {
    writeFileSync(
      ignorePath,
      `# FastPath ignore (also respects .gitignore and .kiroignore)
node_modules/
dist/
build/
coverage/
.yarn/
.nx/
.next/
*.min.js
`,
    );
  }
  ensureAgentsMdFromPack(workspace, AGENT_PACK);
  console.log(`Initialized FastPath in ${workspace}`);
  console.log(`- ${dir}/`);
  console.log(`- ${ignorePath}`);
  console.log(`- ${join(workspace, 'AGENTS.md')} (caveman + ponytail for Default agent)`);
  console.log('Next: fastpath index');
}

function removeIndexDb(workspace: string): void {
  const dbPath = resolveDbPath(workspace);
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

async function cmdIndex(
  workspace: string,
  gitOnly: boolean,
  rebuild: boolean,
): Promise<void> {
  if (rebuild) {
    console.log(`Rebuilding index DB in ${workspace} ...`);
    removeIndexDb(workspace);
    cmdInit(workspace);
  }
  const started = Date.now();
  if (gitOnly) {
    console.log(`Indexing git-changed files in ${workspace} ...`);
    const result = await indexGitChanged(workspace);
    const ms = Date.now() - started;
    console.log(
      `Done. mode=git indexed=${result.filesIndexed} removed=${result.removed} skipped=${result.filesSkipped} files=${result.stats.files} symbols=${result.stats.symbols}`,
    );
    console.log(
      `embed=${result.embedBackend} dim=${result.embedDim} DB=${result.stats.dbPath} ms=${ms}`,
    );
    appendMetric({
      type: 'index',
      at: new Date().toISOString(),
      mode: 'git',
      filesIndexed: result.filesIndexed,
      ms,
    });
    return;
  }

  console.log(`Indexing ${workspace} ...`);
  const result = await indexWorkspace(workspace);
  const ms = Date.now() - started;
  console.log(
    `Done. mode=${rebuild ? 'rebuild' : 'full'} indexed=${result.filesIndexed} skipped=${result.filesSkipped} files=${result.stats.files} symbols=${result.stats.symbols} edges=${result.stats.edges}`,
  );
  console.log(
    `embed=${result.embedBackend} dim=${result.embedDim} DB=${result.stats.dbPath} ms=${ms}`,
  );
  console.log(`At: ${result.stats.indexedAt}`);
  appendMetric({
    type: 'index',
    at: new Date().toISOString(),
    mode: 'full',
    filesIndexed: result.filesIndexed,
    ms,
  });
}

function cmdWatch(workspace: string): void {
  console.log(`Watching ${workspace} (path delta; Ctrl+C to stop) ...`);
  const handle = watchWorkspace(workspace, {
    onIndexed: (result, changed) => {
      console.log(
        `[delta] changed=${changed.length} indexed=${result.filesIndexed} removed=${result.removed} skipped=${result.filesSkipped} symbols=${result.stats.symbols}`,
      );
    },
    onError: (err) => {
      console.error('[watch]', err instanceof Error ? err.message : err);
    },
  });
  process.on('SIGINT', () => {
    handle.close();
    process.exit(0);
  });
}

async function cmdWarm(): Promise<void> {
  console.log('Warming MiniLM embedder...');
  const emb = await warmEmbedder();
  console.log(`embed backend=${emb.backend} dim=${emb.dim}`);
  console.log('Warming cross-encoder reranker...');
  const rerankOk = await warmReranker();
  console.log(`reranker=${rerankOk ? 'ready' : 'skipped/unavailable'}`);
  console.log('Warming tree-sitter grammars...');
  const langs = await warmParsers();
  console.log(`grammars=${langs.join(',') || '(none)'}`);
}

function cmdStatus(workspace: string): void {
  console.log(JSON.stringify(getIndexStats(workspace), null, 2));
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(key).join(value);
  }
  return out;
}

/** POSIX single-quote escape for embedding paths in hook shell commands. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildHookCommand(
  workspace: string,
  home: string,
  script: string,
  extraArgs = '',
): string {
  // FASTPATH_HOME set for path hardening; node still gets absolute script (shell-safe).
  const parts = [
    `FASTPATH_HOME=${shellSingleQuote(home)}`,
    `FASTPATH_WORKSPACE=${shellSingleQuote(workspace)}`,
    'FASTPATH_EMBED=minilm',
    'FASTPATH_RERANK=on',
    `node ${shellSingleQuote(script)}`,
  ];
  if (extraArgs) parts.push(extraArgs);
  return parts.join(' ');
}

function assertIdeCompatibleAgentFile(path: string, body: string): void {
  const bad = findIdeUnsupportedAgentFields(body);
  if (bad.length) {
    throw new Error(
      `${path} contains IDE-unsupported fields (${bad.join(', ')}). ` +
        `Kiro IDE will hide the agent — remove them from packages/agent-pack.`,
    );
  }
  const badCaps = findInvalidPermissionCapabilities(body);
  if (badCaps.length) {
    throw new Error(
      `${path} has invalid permission capability (${badCaps.join(', ')}). ` +
        `Use fs_write / fs_read / shell / subagent — not tool tags like write/read.`,
    );
  }
}

function installAgentTemplates(
  workspace: string,
  agentsDir: string,
  home: string,
  mcpServerPath: string,
): void {
  const values = {
    __FASTPATH_MCP__: mcpServerPath,
    __FASTPATH_WORKSPACE__: workspace,
    __FASTPATH_HOME__: home,
    __MCP_TIMEOUT__: String(McpTimeouts.CONNECT_MS),
    __MCP_REQUEST_TIMEOUT__: String(McpTimeouts.REQUEST_MS),
  };

  for (const name of AGENT_TEMPLATES) {
    const src = join(AGENT_PACK, 'agents', name);
    if (!existsSync(src)) continue;
    assertIdeCompatibleAgentFile(src, readFileSync(src, 'utf8'));
    const body = fillPlaceholders(readFileSync(src, 'utf8'), values);
    assertIdeCompatibleAgentFile(join(agentsDir, name), body);
    writeFileSync(join(agentsDir, name), body);
  }

  // Remove legacy / dual-source agents so the picker stays clean
  for (const legacy of [
    'surgical.md',
    'surgical.json',
    'feature.md',
    'feature.json',
    'Scout.json',
    'Router.md',
    'Marshal.md',
  ]) {
    const p = join(agentsDir, legacy);
    if (existsSync(p)) unlinkSync(p);
  }
}

function copySteeringFile(src: string, dest: string, keep: boolean): void {
  if (keep && existsSync(dest)) {
    console.log(`Keeping existing steering: ${dest}`);
    return;
  }
  copyFileSync(src, dest);
}

function disableSiblingMcps(mcpPath: string): void {
  if (!existsSync(mcpPath)) return;
  try {
    const existing = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers?: Record<string, { disabled?: boolean } & Record<string, unknown>>;
    };
    const servers = existing.mcpServers ?? {};
    let changed = 0;
    for (const [name, cfg] of Object.entries(servers)) {
      if (name === 'fastpath') continue;
      if (cfg?.disabled) continue;
      servers[name] = { ...cfg, disabled: true };
      changed += 1;
    }
    if (changed) {
      const backup = `${mcpPath}.bak-${Date.now()}`;
      copyFileSync(mcpPath, backup);
      existing.mcpServers = servers;
      writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`);
      console.log(`Disabled ${changed} sibling MCP server(s); backup ${backup}`);
    }
  } catch (err) {
    console.error(
      'Could not apply --fastpath-only:',
      err instanceof Error ? err.message : err,
    );
  }
}

function cmdInstallKiro(
  workspace: string,
  opts: { keepSteering?: boolean; fastpathOnly?: boolean } = {},
): void {
  const missing = assertBuiltArtifacts();
  if (missing.length) {
    console.error('Cannot install-kiro — build artifacts missing:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(2);
  }

  const home = resolveFastpathHome();
  const agentsDir = join(workspace, '.kiro/agents');
  const steeringDir = join(workspace, '.kiro/steering');
  const settingsDir = join(workspace, '.kiro/settings');
  const hooksDir = join(workspace, '.kiro/hooks');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(steeringDir, { recursive: true });
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  const mcpServerPath = join(ROOT, 'packages/mcp-server/dist/index.js');
  const cliDist = join(ROOT, 'packages/cli/dist');
  const hookCommands = {
    __FASTPATH_INJECT__: buildHookCommand(workspace, home, join(cliDist, 'prompt-inject.js')),
    __FASTPATH_SESSION_START__: buildHookCommand(
      workspace,
      home,
      join(cliDist, 'session-start.js'),
    ),
    __FASTPATH_FILE_EVENT__: buildHookCommand(workspace, home, join(cliDist, 'file-event.js')),
    __FASTPATH_FILE_EVENT_CREATE__: buildHookCommand(
      workspace,
      home,
      join(cliDist, 'file-event.js'),
      '--create',
    ),
    __FASTPATH_FILE_EVENT_DELETE__: buildHookCommand(
      workspace,
      home,
      join(cliDist, 'file-event.js'),
      '--delete',
    ),
    __FASTPATH_GUARDRAIL__: buildHookCommand(workspace, home, join(cliDist, 'guardrail.js')),
    __FASTPATH_MEMORY_CAPTURE__: buildHookCommand(
      workspace,
      home,
      join(cliDist, 'memory-capture.js'),
    ),
  };

  try {
    installAgentTemplates(workspace, agentsDir, home, mcpServerPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const keep = Boolean(opts.keepSteering);
  copySteeringFile(
    join(AGENT_PACK, 'steering', 'fastpath.md'),
    join(steeringDir, 'fastpath.md'),
    keep,
  );
  copySteeringFile(
    join(AGENT_PACK, 'steering', 'caveman.md'),
    join(steeringDir, 'caveman.md'),
    keep,
  );
  copySteeringFile(
    join(AGENT_PACK, 'steering', 'ponytail.md'),
    join(steeringDir, 'ponytail.md'),
    keep,
  );
  ensureAgentsMdFromPack(workspace, AGENT_PACK);

  mkdirSync(join(workspace, '.kiro/skills'), { recursive: true });
  for (const skill of ['caveman', 'ponytail'] as const) {
    const skillSrc = join(AGENT_PACK, 'skills', skill);
    const skillDest = join(workspace, '.kiro/skills', skill);
    if (existsSync(skillSrc)) {
      cpSync(skillSrc, skillDest, { recursive: true });
    }
  }

  const hookTemplate = readFileSync(
    join(AGENT_PACK, 'hooks', 'fastpath-context.json'),
    'utf8',
  );
  const hookBody = fillPlaceholders(hookTemplate, hookCommands);
  try {
    JSON.parse(hookBody);
  } catch {
    console.error('Generated hook JSON is invalid — aborting install');
    process.exit(2);
  }
  writeFileSync(join(hooksDir, 'fastpath-context.json'), hookBody);

  const mcpPath = join(settingsDir, 'mcp.json');
  const fastpathServer = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      FASTPATH_HOME: home,
      FASTPATH_WORKSPACE: workspace,
      FASTPATH_EMBED: 'minilm',
      FASTPATH_RERANK: 'on',
    },
    disabled: false,
    timeout: McpTimeouts.CONNECT_MS,
    requestTimeout: McpTimeouts.REQUEST_MS,
    autoApprove: [
      'find',
      'impact',
      'window',
      'memory',
      // Legacy names remain callable for older agent profiles.
      'search',
      'symbol',
      'context_for_task',
      'grep_fast',
      'memory_save',
      'memory_recall',
    ],
  };

  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      existing.mcpServers = {
        ...(existing.mcpServers ?? {}),
        fastpath: fastpathServer,
      };
      writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`);
    } catch {
      writeFileSync(
        mcpPath,
        `${JSON.stringify({ mcpServers: { fastpath: fastpathServer } }, null, 2)}\n`,
      );
    }
  } else {
    writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: { fastpath: fastpathServer } }, null, 2)}\n`,
    );
  }

  if (opts.fastpathOnly) {
    disableSiblingMcps(mcpPath);
  }

  const kiroIgnore = join(workspace, '.kiroignore');
  if (!existsSync(kiroIgnore)) {
    copyFileSync(join(AGENT_PACK, 'kiroignore.template'), kiroIgnore);
  }

  recordWorkspaceWired(workspace);

  console.log(`Installed Kiro FastPath pack into ${workspace}`);
  console.log(`FastPath home: ${home}`);
  console.log('- .kiro/agents/Scout.md (gatherer sub-agent, /scout)');
  console.log('- .kiro/agents/Architect.md (6+ files / design, /architect)');
  console.log('- .kiro/steering/fastpath.md (always-on retrieval)');
  console.log('- .kiro/steering/caveman.md (always-on output style)');
  console.log('- .kiro/steering/ponytail.md (always-on minimal-code ladder)');
  console.log('- AGENTS.md (Default-first FastPath + caveman + ponytail)');
  console.log('- .kiro/skills/caveman (slash /caveman intensifier)');
  console.log('- .kiro/skills/ponytail (slash /ponytail intensifier)');
  console.log('- .kiro/hooks/fastpath-context.json (inject + session + file-delta + guardrail)');
  console.log('- .kiro/settings/mcp.json (fastpath server)');
  console.log('');
  console.log('Critical:');
  console.log('1) Default agent is primary — spawn Scout to gather · Architect 6+ when scope fits');
  console.log('2) Confirm all fastpath-* hooks are enabled in Kiro Hook UI');
  console.log('3) Run: fastpath warm && FASTPATH_EMBED=minilm fastpath index && fastpath doctor');
  console.log('4) Optional long sessions: fastpath watch');
  console.log('5) Optional: install-kiro --fastpath-only · --steering=keep');
  printKiroChecklist();
}

function cmdUnwire(workspace: string, purgeIndex: boolean): void {
  const agentsDir = join(workspace, '.kiro/agents');
  for (const name of [
    'Marshal.md',
    'Router.md',
    'Scout.md',
    'Architect.md',
    'Scout.json',
    'surgical.md',
    'surgical.json',
    'feature.md',
    'feature.json',
  ]) {
    const p = join(agentsDir, name);
    if (existsSync(p)) unlinkSync(p);
  }
  const hook = join(workspace, '.kiro/hooks/fastpath-context.json');
  if (existsSync(hook)) unlinkSync(hook);
  for (const name of ['fastpath.md', 'caveman.md', 'ponytail.md'] as const) {
    const steering = join(workspace, '.kiro/steering', name);
    if (existsSync(steering)) unlinkSync(steering);
  }
  for (const skill of ['caveman', 'ponytail'] as const) {
    const skillDir = join(workspace, '.kiro/skills', skill);
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
  }
  removeManagedAgentsMd(workspace);

  const mcpPath = join(workspace, '.kiro/settings/mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (existing.mcpServers?.fastpath) {
        delete existing.mcpServers.fastpath;
        writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`);
      }
    } catch {
      /* leave mcp.json alone if corrupt */
    }
  }

  if (purgeIndex) {
    removeIndexDb(workspace);
    console.log('Purged .fastpath/index.db');
  }

  unrecordWorkspace(workspace);
  console.log(`Unwired FastPath from ${workspace}`);
}

function assertFastpathTree(dir: string, label: string): void {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(dir, 'packages/cli'))) {
    console.error(`${label} is not a FastPath tree: ${dir}`);
    process.exit(2);
  }
  try {
    const name = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }).name;
    if (name !== 'fastpath') {
      console.error(
        `${label} package.json name='${name}' (expected 'fastpath') — did you pass an app repo?`,
      );
      process.exit(2);
    }
  } catch {
    console.error(`Cannot read ${pkgPath}`);
    process.exit(2);
  }
}

/** Sync a FastPath checkout into FASTPATH_HOME (no install-home.sh). */
function syncHomeFromCheckout(src: string, home: string): void {
  const srcAbs = resolve(src);
  const homeAbs = resolve(home);
  assertFastpathTree(srcAbs, 'Source');

  let srcCanon = srcAbs;
  let homeCanon = homeAbs;
  try {
    srcCanon = realpathSync(srcAbs);
    homeCanon = realpathSync(homeAbs);
  } catch {
    /* keep resolved paths */
  }

  if (
    srcCanon === homeCanon ||
    homeCanon.startsWith(`${srcCanon}/`) ||
    srcCanon.startsWith(`${homeCanon}/`)
  ) {
    console.error(
      `Source and FASTPATH_HOME are the same or nested:\n  source: ${srcCanon}\n  home:   ${homeCanon}\n` +
        `Point FASTPATH_HOME at ~/kiro-fastpath and pass --from <checkout>.`,
    );
    process.exit(2);
  }

  mkdirSync(homeAbs, { recursive: true });
  console.log(`Syncing ${srcAbs} → ${homeAbs}`);

  const rsync = spawnSync(
    'rsync',
    [
      '-a',
      '--delete',
      '--exclude',
      'node_modules',
      '--exclude',
      '.fastpath',
      '--exclude',
      'dist-release',
      '--exclude',
      '.git',
      `${srcAbs}/`,
      `${homeAbs}/`,
    ],
    { encoding: 'utf8', stdio: 'inherit' },
  );
  if (rsync.status !== 0) {
    console.log('rsync unavailable/failed — falling back to cp');
    // Best-effort overwrite without wiping home first (safer than find|rm).
    const cp = spawnSync('cp', ['-R', `${srcAbs}/.`, homeAbs], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (cp.status !== 0) process.exit(cp.status ?? 2);
  }

  assertFastpathTree(homeAbs, 'FASTPATH_HOME');
}

function cmdRewire(all: boolean, workspace: string): void {
  const targets = all ? listWiredWorkspaces() : [workspace];
  if (!targets.length) {
    console.error('No wired workspaces in ~/.fastpath/config.json — run `fastpath use` first');
    process.exit(2);
  }
  let done = 0;
  for (const ws of targets) {
    if (!existsSync(ws)) {
      console.error(`SKIP missing workspace: ${ws}`);
      continue;
    }
    // Skip ephemeral test dirs left in the registry.
    if (ws.includes('/var/folders/') || ws.includes('/tmp/')) {
      console.error(`SKIP temp workspace: ${ws}`);
      continue;
    }
    console.log(`\n==> rewire ${ws}`);
    cmdInstallKiro(ws);
    done += 1;
  }
  console.log(`\nRewired ${done} workspace(s).`);
}

function cmdUpgrade(opts: { from?: string; rewire?: boolean } = {}): void {
  const home = resolveFastpathHome();
  if (!existsSync(join(home, 'package.json'))) {
    console.error(`FASTPATH_HOME invalid: ${home}`);
    process.exit(2);
  }
  console.log(`Upgrading FastPath home: ${home}`);

  if (opts.from) {
    syncHomeFromCheckout(opts.from, home);
  } else if (existsSync(join(home, '.git'))) {
    const pull = spawnSync('git', ['pull', '--ff-only'], {
      cwd: home,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (pull.status !== 0) {
      console.error('git pull failed — fix conflicts or run manually');
      process.exit(pull.status ?? 2);
    }
  } else {
    console.error(
      'FASTPATH_HOME has no .git — cannot pull.\n' +
        'Sync from your checkout (no install-home.sh):\n' +
        `  fastpath upgrade --from /path/to/kiro-fastpath-checkout --rewire\n` +
        'Example:\n' +
        `  fastpath upgrade --from /Volumes/ADATA/Projects/fastpath --rewire`,
    );
    process.exit(2);
  }

  const ci = spawnSync('npm', ['ci'], { cwd: home, encoding: 'utf8', stdio: 'inherit' });
  if (ci.status !== 0) {
    console.log('npm ci failed — trying npm install');
    const inst = spawnSync('npm', ['install'], {
      cwd: home,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (inst.status !== 0) process.exit(inst.status ?? 2);
  }

  const build = spawnSync('npm', ['run', 'build'], {
    cwd: home,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 2);

  // Sanity: new agent-mode files must exist after this big update.
  const mustExist = [
    join(home, 'packages/cli/dist/routing.js'),
    join(home, 'packages/cli/dist/prompt-inject.js'),
    join(home, 'packages/agent-pack/agents/Scout.md'),
  ];
  for (const p of mustExist) {
    if (!existsSync(p)) {
      console.error(`Upgrade incomplete — missing ${p}`);
      process.exit(2);
    }
  }
  const scout = readFileSync(join(home, 'packages/agent-pack/agents/Scout.md'), 'utf8');
  if (!/context-gathering/.test(scout) || !/claude-haiku-4\.5/.test(scout)) {
    console.error(
      'Upgrade incomplete — Scout.md still looks old (expected gatherer + claude-haiku-4.5)',
    );
    process.exit(2);
  }

  const cfg = loadConfig();
  cfg.home = home;
  cfg.version = readPackageVersion(home);
  saveConfig(cfg);

  console.log(`\nUpgraded to v${cfg.version}`);
  const wired = listWiredWorkspaces().filter(
    (w) => existsSync(w) && !w.includes('/var/folders/') && !w.includes('/tmp/'),
  );
  if (wired.length) {
    console.log(`Known workspaces (${wired.length}):`);
    for (const w of wired) console.log(`  ${w}`);
  }

  if (opts.rewire) {
    console.log('\n==> rewire --all (refresh agents/hooks/steering)');
    cmdRewire(true, home);
  } else {
    console.log('Next: fastpath rewire --all   # refresh agent/hook absolute paths');
  }
}

function cmdRepairNative(): void {
  const home = resolveFastpathHome();
  console.log(`Rebuilding natives in ${home}`);
  const r = spawnSync(
    'npm',
    ['rebuild', 'better-sqlite3', 'onnxruntime-node', 'sharp'],
    { cwd: home, encoding: 'utf8', stdio: 'inherit' },
  );
  process.exit(r.status ?? 2);
}

async function cmdEval(office: boolean, golden = false): Promise<void> {
  if (golden) {
    const { runGoldenEval, formatGolden, goldenFailures } = await import('./eval-golden.js');
    const metrics = await runGoldenEval(ROOT);
    console.log(formatGolden(metrics));
    const failures = goldenFailures(metrics);
    for (const f of failures) console.log(`  BELOW THRESHOLD ${f}`);
    process.exit(failures.length ? 2 : 0);
  }
  if (office) {
    const { runOfficeEval } = await import('./eval-office.js');
    const result = await runOfficeEval(ROOT);
    console.log(`office eval passed=${result.passed} failed=${result.failed.length}`);
    for (const f of result.failed) console.log(`  FAIL ${f}`);
    process.exit(result.failed.length ? 2 : 0);
  }
  const result = await runBuiltinEval(ROOT);
  console.log(`eval passed=${result.passed} failed=${result.failed.length}`);
  for (const f of result.failed) console.log(`  FAIL ${f}`);
  process.exit(result.failed.length ? 2 : 0);
}

async function cmdMemory(args: string[]): Promise<void> {
  const [sub, ...restArgs] = args;
  const workspace = workspaceFromArgs(restArgs.filter((a) => !/^\d+$/.test(a)));

  switch (sub) {
    case 'list': {
      const memories = listMemories(workspace);
      if (!memories.length) {
        console.log('No memories yet.');
        return;
      }
      for (const m of memories) {
        const paths = m.paths.length ? ` [${m.paths.join(', ')}]` : '';
        console.log(`#${m.id} (${m.kind}, used ${m.useCount}x) ${m.text}${paths}`);
      }
      return;
    }
    case 'forget': {
      const id = Number(restArgs.find((a) => /^\d+$/.test(a)));
      if (!Number.isInteger(id)) {
        console.error('usage: fastpath memory forget <id> [workspace]');
        process.exit(1);
      }
      console.log(forgetMemory(workspace, id) ? `Forgot memory #${id}` : `No memory #${id}`);
      return;
    }
    case 'distill': {
      const steeringDir = join(workspace, '.kiro/steering');
      mkdirSync(steeringDir, { recursive: true });
      const out = join(steeringDir, 'fastpath-memory.md');
      writeFileSync(out, distillMemories(workspace));
      console.log(`Distilled durable memories → ${out} (inclusion: manual)`);
      return;
    }
    default:
      console.error('usage: fastpath memory list|forget <id>|distill [workspace]');
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  switch (cmd) {
    case 'init':
      cmdInit(workspaceFromArgs(rest));
      break;
    case 'index': {
      const git = takeFlag(rest, '--git');
      const rebuild = takeFlag(git.args, '--rebuild');
      await cmdIndex(workspaceFromArgs(rebuild.args), git.set, rebuild.set);
      break;
    }
    case 'watch':
      cmdWatch(workspaceFromArgs(rest));
      break;
    case 'warm':
      await cmdWarm();
      break;
    case 'status':
      cmdStatus(workspaceFromArgs(rest));
      break;
    case 'doctor': {
      const json = takeFlag(rest, '--json');
      const result = await runDoctor(workspaceFromArgs(json.args));
      printDoctor(result, json.set);
      process.exit(result.ready ? 0 : 2);
      break;
    }
    case 'eval': {
      const office = takeFlag(rest, '--office');
      const golden = takeFlag(office.args, '--golden');
      await cmdEval(office.set, golden.set);
      break;
    }
    case 'bench': {
      const { loadBenchTasks, runBench, formatBench } = await import('./bench.js');
      let args = rest;
      let tasksPath: string | undefined;
      const idx = args.indexOf('--tasks');
      if (idx >= 0) {
        tasksPath = args[idx + 1];
        args = args.filter((_, i) => i !== idx && i !== idx + 1);
      }
      const workspace = workspaceFromArgs(args);
      const tasks = tasksPath
        ? loadBenchTasks(resolve(tasksPath))
        : [
            { prompt: 'where do we validate the auth token' },
            { prompt: 'user login flow' },
            { prompt: 'how is tax calculated' },
          ];
      console.log(formatBench(await runBench(workspace, tasks)));
      break;
    }
    case 'install-kiro':
    case 'repair-kiro': {
      const keep = takeFlag(rest, '--steering=keep');
      // also accept --steering keep as two tokens
      let args = keep.args;
      let keepSteering = keep.set;
      if (!keepSteering) {
        const idx = args.indexOf('--steering');
        if (idx >= 0 && args[idx + 1] === 'keep') {
          keepSteering = true;
          args = args.filter((_, i) => i !== idx && i !== idx + 1);
        }
      }
      const only = takeFlag(args, '--fastpath-only');
      cmdInstallKiro(workspaceFromArgs(only.args), {
        keepSteering,
        fastpathOnly: only.set,
      });
      break;
    }
    case 'use': {
      const keep = takeFlag(rest, '--steering=keep');
      let args = keep.args;
      let keepSteering = keep.set;
      if (!keepSteering) {
        const idx = args.indexOf('--steering');
        if (idx >= 0 && args[idx + 1] === 'keep') {
          keepSteering = true;
          args = args.filter((_, i) => i !== idx && i !== idx + 1);
        }
      }
      const only = takeFlag(args, '--fastpath-only');
      cmdInstallKiro(workspaceFromArgs(only.args), {
        keepSteering,
        fastpathOnly: only.set,
      });
      break;
    }
    case 'rewire': {
      const all = takeFlag(rest, '--all');
      cmdRewire(all.set, workspaceFromArgs(all.args));
      break;
    }
    case 'unwire': {
      const purge = takeFlag(rest, '--purge-index');
      cmdUnwire(workspaceFromArgs(purge.args), purge.set);
      break;
    }
    case 'upgrade': {
      const rewireFlag = takeFlag(rest, '--rewire');
      let args = rewireFlag.args;
      let from: string | undefined;
      const fromIdx = args.indexOf('--from');
      if (fromIdx >= 0) {
        from = args[fromIdx + 1];
        if (!from || from.startsWith('--')) {
          console.error('usage: fastpath upgrade [--from <checkout>] [--rewire]');
          process.exit(2);
        }
        args = args.filter((_, i) => i !== fromIdx && i !== fromIdx + 1);
      }
      cmdUpgrade({ from, rewire: rewireFlag.set });
      break;
    }
    case 'repair-native':
      cmdRepairNative();
      break;
    case 'home':
    case 'version': {
      const home = resolveFastpathHome();
      console.log(
        JSON.stringify(
          {
            version: readPackageVersion(home),
            home,
            cli: join(home, 'packages/cli/dist/index.js'),
            wired: listWiredWorkspaces(),
          },
          null,
          2,
        ),
      );
      break;
    }
    case 'metrics': {
      const summary = takeFlag(rest, '--summary');
      const tokens = takeFlag(summary.args, '--tokens');
      const ws = workspaceFromArgs(tokens.args);
      const events = readMetrics();
      if (tokens.set) console.log(JSON.stringify(tokenLedger(events), null, 2));
      else if (summary.set) console.log(summarizeMetrics(events, ws));
      else console.log(JSON.stringify(events, null, 2));
      break;
    }
    case 'memory':
      await cmdMemory(rest);
      break;
    case 'viz': {
      const noOpen = takeFlag(rest, '--no-open');
      let args = noOpen.args;
      let outPath: string | undefined;
      const outIdx = args.indexOf('--out');
      if (outIdx >= 0) {
        outPath = args[outIdx + 1];
        if (!outPath) {
          console.error('usage: fastpath viz [workspace] [--no-open] [--out file.html]');
          process.exit(1);
        }
        args = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);
      }
      const workspace = workspaceFromArgs(args);
      try {
        const { outPath: written, data } = runViz({
          workspace,
          outPath: outPath ? resolve(outPath) : undefined,
          openBrowser: !noOpen.set,
        });
        console.log(`FastPath viz → ${written}`);
        console.log(
          `files=${data.summary.files} symbols=${data.summary.symbols} calls=${data.summary.callEdges} memories=${data.summary.memories}`,
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
