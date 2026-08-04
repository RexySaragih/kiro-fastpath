#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
  printDoctor,
  runDoctor,
} from './doctor.js';
import { runBuiltinEval } from './eval.js';
import { appendMetric, readMetrics, summarizeMetrics } from './metrics.js';

const ROOT = PACKAGE_ROOT;
const AGENT_PACK = join(ROOT, 'packages/agent-pack');

/** IDE agents only — Scout.json removed (dual-source drift). */
const AGENT_TEMPLATES = ['Router.md', 'Scout.md', 'Architect.md'] as const;

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
  fastpath eval [--office]               Retrieval eval (builtin or office goldens)
  fastpath install-kiro|repair-kiro|use [workspace]
  fastpath rewire [--all] [workspace]    Re-run install-kiro (path refresh)
  fastpath unwire [workspace] [--purge-index]
  fastpath upgrade                       git pull + npm ci + build in FASTPATH_HOME
  fastpath repair-native                 Rebuild better-sqlite3 / onnx / sharp
  fastpath home|version|metrics [--summary]
  fastpath memory list|forget <id>|distill [workspace]

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
  console.log('  3) Chat agent picker → Workspace → Router (default; auto-delegates)');
  console.log('     Or drive directly: Scout (small edits) / Architect (multi-file)');
  console.log('  4) Hook UI → enable all fastpath-* hooks');
  console.log('  5) Effort: Router/Scout → /effort low · Architect → /effort medium');
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
  console.log(`Initialized FastPath in ${workspace}`);
  console.log(`- ${dir}/`);
  console.log(`- ${ignorePath}`);
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
  if (!bad.length) return;
  throw new Error(
    `${path} contains IDE-unsupported fields (${bad.join(', ')}). ` +
      `Kiro IDE will hide the agent — remove them from packages/agent-pack.`,
  );
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
  ]) {
    const p = join(agentsDir, legacy);
    if (existsSync(p)) unlinkSync(p);
  }
}

function cmdInstallKiro(workspace: string): void {
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

  copyFileSync(
    join(AGENT_PACK, 'steering', 'fastpath.md'),
    join(steeringDir, 'fastpath.md'),
  );

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
      'search',
      'symbol',
      'context_for_task',
      'grep_fast',
      'impact',
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

  const kiroIgnore = join(workspace, '.kiroignore');
  if (!existsSync(kiroIgnore)) {
    copyFileSync(join(AGENT_PACK, 'kiroignore.template'), kiroIgnore);
  }

  recordWorkspaceWired(workspace);

  console.log(`Installed Kiro FastPath pack into ${workspace}`);
  console.log(`FastPath home: ${home}`);
  console.log('- .kiro/agents/Router.md (default — auto-routes to Scout/Architect)');
  console.log('- .kiro/agents/Scout.md (small edits, /scout)');
  console.log('- .kiro/agents/Architect.md (multi-file features, /architect)');
  console.log('- .kiro/steering/fastpath.md (always-on)');
  console.log('- .kiro/hooks/fastpath-context.json (inject + session + file-delta + guardrail)');
  console.log('- .kiro/settings/mcp.json (fastpath server)');
  console.log('');
  console.log('Critical:');
  console.log('1) Select agent "Router" (default) — or Scout/Architect directly');
  console.log('2) Confirm all fastpath-* hooks are enabled in Kiro Hook UI');
  console.log('3) Run: fastpath warm && FASTPATH_EMBED=minilm fastpath index && fastpath doctor');
  console.log('4) Optional long sessions: fastpath watch');
  console.log('5) Disable other MCP servers for daily coding');
  printKiroChecklist();
}

function cmdUnwire(workspace: string, purgeIndex: boolean): void {
  const agentsDir = join(workspace, '.kiro/agents');
  for (const name of [
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
  const steering = join(workspace, '.kiro/steering/fastpath.md');
  if (existsSync(steering)) unlinkSync(steering);

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

function cmdRewire(all: boolean, workspace: string): void {
  const targets = all ? listWiredWorkspaces() : [workspace];
  if (!targets.length) {
    console.error('No wired workspaces in ~/.fastpath/config.json — run `fastpath use` first');
    process.exit(2);
  }
  for (const ws of targets) {
    if (!existsSync(ws)) {
      console.error(`SKIP missing workspace: ${ws}`);
      continue;
    }
    console.log(`\n==> rewire ${ws}`);
    cmdInstallKiro(ws);
  }
}

function cmdUpgrade(): void {
  const home = resolveFastpathHome();
  if (!existsSync(join(home, 'package.json'))) {
    console.error(`FASTPATH_HOME invalid: ${home}`);
    process.exit(2);
  }
  console.log(`Upgrading FastPath home: ${home}`);
  if (existsSync(join(home, '.git'))) {
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
    console.log('(no .git — skipped pull; sync via install-home if needed)');
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

  const cfg = loadConfig();
  cfg.home = home;
  cfg.version = readPackageVersion(home);
  saveConfig(cfg);

  console.log(`\nUpgraded to v${cfg.version}`);
  console.log('Next: fastpath rewire --all   # refresh agent/hook absolute paths');
  const wired = listWiredWorkspaces();
  if (wired.length) {
    console.log(`Known workspaces (${wired.length}):`);
    for (const w of wired) console.log(`  ${w}`);
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

async function cmdEval(office: boolean): Promise<void> {
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
      await cmdEval(office.set);
      break;
    }
    case 'install-kiro':
    case 'repair-kiro':
      cmdInstallKiro(workspaceFromArgs(rest));
      break;
    case 'use':
      cmdInstallKiro(workspaceFromArgs(rest));
      break;
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
    case 'upgrade':
      cmdUpgrade();
      break;
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
      const events = readMetrics();
      if (summary.set) console.log(summarizeMetrics(events));
      else console.log(JSON.stringify(events, null, 2));
      break;
    }
    case 'memory':
      await cmdMemory(rest);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
