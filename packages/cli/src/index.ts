#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getIndexStats,
  getMeta,
  indexGitChanged,
  indexWorkspace,
  openDatabase,
  resolveDbPath,
  watchWorkspace,
  warmEmbedder,
  warmParsers,
  warmReranker,
} from '@fastpath/core';
import {
  PACKAGE_ROOT,
  readPackageVersion,
  recordWorkspaceWired,
  resolveFastpathHome,
} from './config.js';
import { runBuiltinEval } from './eval.js';
import { appendMetric, readMetrics, summarizeMetrics } from './metrics.js';

const ROOT = PACKAGE_ROOT;
const AGENT_PACK = join(ROOT, 'packages/agent-pack');

function usage(): never {
  const ver = readPackageVersion();
  console.log(`fastpath — Kiro Fast-Path CLI v${ver}

Usage:
  fastpath init [workspace]           Create .fastpath/ + ignore starter
  fastpath index [workspace] [--git]  Full index, or git-changed only
  fastpath watch [workspace]          Path-delta re-index on file changes
  fastpath status [workspace]         Show index stats
  fastpath doctor [workspace] [--json]
  fastpath warm                       Download MiniLM + reranker + grammars
  fastpath eval                       Built-in retrieval eval harness
  fastpath install-kiro [workspace]   Agents + MCP + inject hook
  fastpath repair-kiro [workspace]    Alias of install-kiro
  fastpath use [workspace]            Wire workspace + registry
  fastpath home                       Print FASTPATH_HOME + version
  fastpath version                    Print version + home
  fastpath metrics [--summary]        Local metrics (no network)

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
  console.log('  2) Chat agent picker → Workspace → Scout (daily) or Architect');
  console.log('  3) Hook UI → enable fastpath-auto-context');
  console.log('  4) Effort: Scout → /effort low · Architect → /effort medium');
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

async function cmdIndex(workspace: string, gitOnly: boolean): Promise<void> {
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
    `Done. mode=full indexed=${result.filesIndexed} skipped=${result.filesSkipped} files=${result.stats.files} symbols=${result.stats.symbols} edges=${result.stats.edges}`,
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

function buildInjectCommand(workspace: string, injectScript: string): string {
  return [
    `FASTPATH_WORKSPACE=${shellSingleQuote(workspace)}`,
    'FASTPATH_EMBED=minilm',
    'FASTPATH_RERANK=on',
    `node ${shellSingleQuote(injectScript)}`,
  ].join(' ');
}

/** Fields Kiro IDE rejects (agent silently dropped from Workspace picker). */
const IDE_UNSUPPORTED_AGENT_FIELDS = ['allowedTools', 'includeMcpJson', 'toolsSettings'] as const;

function findIdeUnsupportedAgentFields(body: string): string[] {
  return IDE_UNSUPPORTED_AGENT_FIELDS.filter((field) =>
    new RegExp(`\\b${field}\\b`).test(body),
  );
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
  mcpServerPath: string,
  injectCmd: string,
): void {
  const values = {
    __FASTPATH_MCP__: mcpServerPath,
    __FASTPATH_WORKSPACE__: workspace,
    __FASTPATH_INJECT__: injectCmd,
  };

  for (const name of ['Scout.md', 'Architect.md', 'Scout.json']) {
    const src = join(AGENT_PACK, 'agents', name);
    if (!existsSync(src)) continue;
    // Fail before writing a broken pack into the target workspace
    assertIdeCompatibleAgentFile(src, readFileSync(src, 'utf8'));
    const body = fillPlaceholders(readFileSync(src, 'utf8'), values);
    assertIdeCompatibleAgentFile(join(agentsDir, name), body);
    writeFileSync(join(agentsDir, name), body);
  }

  // Remove legacy agent names so the picker stays clean
  for (const legacy of ['surgical.md', 'surgical.json', 'feature.md', 'feature.json']) {
    const p = join(agentsDir, legacy);
    if (existsSync(p)) unlinkSync(p);
  }
}

function assertBuiltArtifacts(): string[] {
  const missing: string[] = [];
  const mcpServerPath = join(ROOT, 'packages/mcp-server/dist/index.js');
  const injectScript = join(ROOT, 'packages/cli/dist/prompt-inject.js');
  if (!existsSync(mcpServerPath)) missing.push(`MCP server missing: ${mcpServerPath} (npm run build)`);
  if (!existsSync(injectScript)) missing.push(`prompt-inject missing: ${injectScript} (npm run build)`);
  return missing;
}

function cmdDoctor(workspace: string, asJson: boolean): void {
  const issues: string[] = [];
  const ok: string[] = [];
  const dbPath = resolveDbPath(workspace);
  const stats = getIndexStats(workspace);
  let embedBackend = 'unknown';
  let agentsIdeCompatible = false;
  let hookEnabled = false;

  for (const miss of assertBuiltArtifacts()) issues.push(miss);

  if (!existsSync(dbPath)) {
    issues.push('Index DB missing — run `fastpath index`');
  } else if (stats.files === 0) {
    issues.push('Index empty — run `fastpath index`');
  } else {
    ok.push(`Index ready: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges`);
  }

  if (existsSync(dbPath)) {
    try {
      const db = openDatabase(dbPath, { create: false });
      try {
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
        // Table presence matters for SCOUT READY; empty is fine for tiny fixtures.
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
  const scoutMd = join(agentsDir, 'Scout.md');
  if (existsSync(scoutMd)) {
    const body = readFileSync(scoutMd, 'utf8');
    ok.push('Scout agent installed');
    if (!body.includes('@fastpath')) {
      issues.push('Scout agent missing `@fastpath` in tools — re-run `fastpath install-kiro`');
    } else ok.push('Scout tools bind @fastpath');
    if (!body.includes('mcpServers:') && !body.includes('"mcpServers"')) {
      issues.push('Scout agent missing inline mcpServers — re-run `fastpath install-kiro`');
    } else ok.push('Scout has inline mcpServers');
    if (body.includes('__FASTPATH_')) {
      issues.push('Scout agent still has unresolved placeholders — re-run `fastpath install-kiro`');
    }
  } else {
    issues.push('Scout agent missing — run `fastpath install-kiro`');
  }

  // Scan every installed agent — IDE drops any file with these fields
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

  const hookPath = join(workspace, '.kiro/hooks/fastpath-context.json');
  if (existsSync(hookPath)) {
    const hookBody = readFileSync(hookPath, 'utf8');
    if (hookBody.includes('__FASTPATH_')) {
      issues.push('hook placeholders unresolved — re-run `fastpath install-kiro`');
    } else {
      try {
        const hookJson = JSON.parse(hookBody) as {
          hooks?: Array<{ trigger?: string; action?: { command?: string }; enabled?: boolean }>;
        };
        const inject = hookJson.hooks?.find((h) => h.trigger === 'UserPromptSubmit');
        if (!inject) {
          issues.push('fastpath hook missing UserPromptSubmit trigger');
        } else if (inject.enabled === false) {
          issues.push('fastpath-auto-context hook is disabled — enable in Kiro Hook UI');
        } else if (!inject.action?.command?.includes('prompt-inject')) {
          issues.push('UserPromptSubmit hook command does not point at prompt-inject');
        } else {
          hookEnabled = true;
          ok.push('UserPromptSubmit auto-inject hook installed');
        }
      } catch {
        issues.push('fastpath-context.json is not valid JSON');
      }
    }
  } else {
    issues.push('auto-inject hook missing — run `fastpath install-kiro` (index alone will not be used)');
  }

  const mcpPath = join(workspace, '.kiro/settings/mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers?: Record<string, { disabled?: boolean }>;
      };
      const servers = mcp.mcpServers ?? {};
      const enabled = Object.entries(servers).filter(([, v]) => !v?.disabled);
      if (enabled.length > 3) {
        issues.push(`${enabled.length} MCP servers enabled — keep FastPath-only for Scout speed`);
      } else {
        ok.push(`MCP servers enabled: ${enabled.length}`);
      }
      if (!servers.fastpath || servers.fastpath.disabled) {
        issues.push('fastpath MCP missing/disabled in mcp.json');
      } else ok.push('fastpath MCP configured');
    } catch {
      issues.push('mcp.json unreadable');
    }
  } else {
    issues.push('mcp.json missing — run `fastpath install-kiro`');
  }

  const ready = issues.length === 0;
  appendMetric({
    type: 'doctor',
    at: new Date().toISOString(),
    ready,
    issueCount: issues.length,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ready,
          issues,
          ok,
          stats,
          embedBackend,
          agentsIdeCompatible,
          hookEnabled,
          version: readPackageVersion(),
          home: resolveFastpathHome(),
          workspace,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`# fastpath doctor — ${workspace}\n`);
    for (const line of ok) console.log(`OK  ${line}`);
    for (const line of issues) console.log(`!!  ${line}`);
    if (ready) {
      console.log('\nSCOUT READY');
      console.log('In Kiro: select agent "Scout". Verify hooks enabled in Hook UI.');
    } else {
      console.log(`\nNOT READY (${issues.length} issue(s))`);
    }
  }
  process.exit(ready ? 0 : 2);
}

function cmdInstallKiro(workspace: string): void {
  const missing = assertBuiltArtifacts();
  if (missing.length) {
    console.error('Cannot install-kiro — build artifacts missing:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(2);
  }

  const agentsDir = join(workspace, '.kiro/agents');
  const steeringDir = join(workspace, '.kiro/steering');
  const settingsDir = join(workspace, '.kiro/settings');
  const hooksDir = join(workspace, '.kiro/hooks');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(steeringDir, { recursive: true });
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  const mcpServerPath = join(ROOT, 'packages/mcp-server/dist/index.js');
  const injectScript = join(ROOT, 'packages/cli/dist/prompt-inject.js');
  const injectCmd = buildInjectCommand(workspace, injectScript);

  try {
    installAgentTemplates(workspace, agentsDir, mcpServerPath, injectCmd);
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
  const hookBody = fillPlaceholders(hookTemplate, { __FASTPATH_INJECT__: injectCmd });
  try {
    JSON.parse(hookBody);
  } catch {
    console.error('Generated hook JSON is invalid — aborting install');
    process.exit(2);
  }
  writeFileSync(join(hooksDir, 'fastpath-context.json'), hookBody);

  const scoutJsonPath = join(agentsDir, 'Scout.json');
  if (existsSync(scoutJsonPath)) {
    try {
      JSON.parse(readFileSync(scoutJsonPath, 'utf8'));
    } catch {
      console.error('Generated Scout.json is invalid — aborting install');
      process.exit(2);
    }
  }

  const mcpPath = join(settingsDir, 'mcp.json');
  const fastpathServer = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      FASTPATH_WORKSPACE: workspace,
      FASTPATH_EMBED: 'minilm',
      FASTPATH_RERANK: 'on',
    },
    disabled: false,
    autoApprove: [
      'search',
      'symbol',
      'context_for_task',
      'grep_fast',
      'impact',
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
  console.log(`FastPath home: ${resolveFastpathHome()}`);
  console.log('- .kiro/agents/Scout.md + Scout.json (daily work)');
  console.log('- .kiro/agents/Architect.md (multi-file features)');
  console.log('- .kiro/steering/fastpath.md (always-on)');
  console.log('- .kiro/hooks/fastpath-context.json (UserPromptSubmit → auto-inject)');
  console.log('- .kiro/settings/mcp.json (fastpath server)');
  console.log('');
  console.log('Critical:');
  console.log('1) Select agent "Scout" (daily) or "Architect" (bigger changes)');
  console.log('2) Confirm hook "fastpath-auto-context" is enabled in Kiro Hook UI');
  console.log('3) Run: fastpath warm && FASTPATH_EMBED=minilm fastpath index && fastpath doctor');
  console.log('4) Optional long sessions: fastpath watch');
  console.log('5) Disable other MCP servers for daily coding');
  printKiroChecklist();
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  switch (cmd) {
    case 'init':
      cmdInit(workspaceFromArgs(rest));
      break;
    case 'index': {
      const { args, set: gitOnly } = takeFlag(rest, '--git');
      await cmdIndex(workspaceFromArgs(args), gitOnly);
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
      const { args, set: asJson } = takeFlag(rest, '--json');
      cmdDoctor(workspaceFromArgs(args), asJson);
      break;
    }
    case 'eval': {
      const result = await runBuiltinEval(ROOT);
      console.log(`eval passed=${result.passed} failed=${result.failed.length}`);
      for (const f of result.failed) console.log(`  FAIL ${f}`);
      process.exit(result.failed.length ? 2 : 0);
      break;
    }
    case 'install-kiro':
    case 'repair-kiro':
      cmdInstallKiro(workspaceFromArgs(rest));
      break;
    case 'use':
      cmdInstallKiro(workspaceFromArgs(rest));
      break;
    case 'home':
    case 'version': {
      const home = resolveFastpathHome();
      console.log(
        JSON.stringify(
          { version: readPackageVersion(home), home, cli: join(home, 'packages/cli/dist/index.js') },
          null,
          2,
        ),
      );
      break;
    }
    case 'metrics': {
      const summary = rest.includes('--summary');
      const events = readMetrics(500);
      if (summary) console.log(summarizeMetrics(events));
      else console.log(JSON.stringify(events, null, 2));
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
