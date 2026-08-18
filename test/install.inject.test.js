import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const inject = join(root, 'packages/cli/dist/prompt-inject.js');

const testEnv = {
  ...process.env,
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

test('getIndexStats does not create DB when missing', async () => {
  const { getIndexStats, resolveDbPath } = await import(
    join(root, 'packages/core/dist/index.js')
  );
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-nostats-'));
  try {
    const stats = getIndexStats(dir);
    assert.equal(stats.files, 0);
    assert.equal(existsSync(resolveDbPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install-kiro writes valid hook JSON and wired agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-install-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/hello.ts'),
      'export function hello() { return greet(); }\nfunction greet() { return 1; }\n',
    );
    mkdirSync(join(dir, '.kiro/agents'), { recursive: true });
    writeFileSync(join(dir, '.kiro/agents/surgical.md'), 'legacy\n');
    writeFileSync(join(dir, '.kiro/agents/Scout.json'), '{"name":"legacy"}\n');

    const init = spawnSync(process.execPath, [cli, 'init', dir], {
      encoding: 'utf8',
      env: testEnv,
    });
    assert.equal(init.status, 0, init.stderr);
    const agentsAfterInit = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agentsAfterInit, /<!-- fastpath:agents -->/);
    assert.match(agentsAfterInit, /OUTPUT MODE = caveman full/);
    assert.match(agentsAfterInit, /CODE MODE = ponytail full/);
    assert.match(agentsAfterInit, /YAGNI/);

    const index = spawnSync(process.execPath, [cli, 'index', dir], {
      encoding: 'utf8',
      env: testEnv,
    });
    assert.equal(index.status, 0, index.stderr);

    const install = spawnSync(process.execPath, [cli, 'install-kiro', dir], {
      encoding: 'utf8',
      env: testEnv,
    });
    assert.equal(install.status, 0, install.stderr + install.stdout);

    const hookPath = join(dir, '.kiro/hooks/fastpath-context.json');
    const hook = JSON.parse(readFileSync(hookPath, 'utf8'));
    assert.equal(hook.hooks[0].trigger, 'UserPromptSubmit');
    assert.match(hook.hooks[0].action.command, /prompt-inject/);
    assert.match(hook.hooks[0].action.command, /FASTPATH_HOME=/);
    assert.equal(readFileSync(hookPath, 'utf8').includes('__FASTPATH_'), false);
    const modeHooks = hook.hooks.filter(
      (entry) =>
        entry.trigger === 'UserPromptSubmit' || entry.trigger === 'SessionStart',
    );
    assert.equal(modeHooks.length, 2);
    for (const entry of modeHooks) {
      assert.match(entry.description, /Caveman/i);
      assert.match(entry.description, /Ponytail/i);
    }

    const scout = readFileSync(join(dir, '.kiro/agents/Scout.md'), 'utf8');
    assert.match(scout, /@fastpath/);
    assert.doesNotMatch(scout, /__FASTPATH_/);
    assert.match(scout, /mcpServers:/);
    assert.match(scout, /FASTPATH_HOME:/);
    assert.match(scout, /timeout:\s*\d+/);
    assert.match(scout, /requestTimeout:\s*\d+/);
    assert.match(scout, /permissions:/);
    assert.doesNotMatch(scout, /\ballowedTools\b/);
    assert.doesNotMatch(scout, /\bincludeMcpJson\b/);
    assert.doesNotMatch(scout, /\btoolsSettings\b/);
    assert.match(scout, /name:\s*Scout/);
    assert.match(scout, /tools:\s*\["read",\s*"@fastpath"\]/);

    assert.equal(existsSync(join(dir, '.kiro/agents/Scout.json')), false);

    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /<!-- fastpath:agents -->/);
    assert.match(agentsMd, /OUTPUT MODE = caveman full/);
    assert.match(agentsMd, /CODE MODE = ponytail full/);
    assert.ok(existsSync(join(dir, '.kiro/steering/caveman.md')));
    assert.ok(existsSync(join(dir, '.kiro/steering/ponytail.md')));
    assert.ok(existsSync(join(dir, '.kiro/skills/caveman/SKILL.md')));
    assert.ok(existsSync(join(dir, '.kiro/skills/ponytail/SKILL.md')));
    assert.match(scout, /skill:\/\/\.kiro\/skills\/caveman\/SKILL\.md/);
    assert.doesNotMatch(scout, /skill:\/\/\.kiro\/skills\/ponytail\/SKILL\.md/);
    assert.match(scout, /OUTPUT MODE = caveman full.*MANDATORY/i);
    assert.doesNotMatch(scout, /CODE MODE = ponytail full/);

    const architect = readFileSync(join(dir, '.kiro/agents/Architect.md'), 'utf8');
    assert.doesNotMatch(architect, /\ballowedTools\b/);
    assert.doesNotMatch(architect, /\bincludeMcpJson\b/);
    assert.match(architect, /name:\s*Architect/);
    assert.match(architect, /FASTPATH_HOME:/);
    assert.match(architect, /skill:\/\/\.kiro\/skills\/caveman\/SKILL\.md/);
    assert.match(architect, /skill:\/\/\.kiro\/skills\/ponytail\/SKILL\.md/);
    assert.match(architect, /OUTPUT MODE = caveman full.*MANDATORY/i);
    assert.match(architect, /CODE MODE = ponytail full.*MANDATORY/i);
    assert.match(architect, /toolsSettings:/);
    assert.match(architect, /availableAgents:\s*\["Scout"\]/);
    assert.match(architect, /trustedAgents:\s*\["Scout"\]/);
    assert.equal(existsSync(join(dir, '.kiro/agents/surgical.md')), false);

    const mcp = JSON.parse(readFileSync(join(dir, '.kiro/settings/mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.fastpath.env.FASTPATH_HOME);
    assert.equal(mcp.mcpServers.fastpath.env.FASTPATH_EMBED, 'minilm');
    assert.ok(mcp.mcpServers.fastpath.timeout >= 60000);
    assert.ok(mcp.mcpServers.fastpath.requestTimeout >= 180000);

    const doctor = spawnSync(process.execPath, [cli, 'doctor', dir], {
      encoding: 'utf8',
      env: testEnv,
    });
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    // Install is issue-free; liveness is separate (hooks have never fired in a
    // fresh temp user dir, so doctor reports UNVERIFIED rather than READY).
    assert.doesNotMatch(doctor.stdout, /NOT READY/);
    assert.match(doctor.stdout, /SCOUT READY|UNVERIFIED/);
    assert.match(doctor.stdout, /Hook matchers compile as JS RegExp/);
    assert.match(doctor.stdout, /Call graph table ready/);
    assert.match(doctor.stdout, /Agent pack IDE-compatible/);
    assert.match(doctor.stdout, /Search smoke OK/);
    assert.match(doctor.stdout, /Architect agent installed/);
    assert.match(doctor.stdout, /AGENTS\.md includes caveman \+ ponytail/);
    assert.match(doctor.stdout, /Ponytail skill installed/);
    assert.match(doctor.stdout, /MCP tool surface: FastPath only/);
    assert.match(doctor.stdout, /Steering includes Ponytail full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt-inject returns FastPath hits for indexed workspace', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-inject-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const result = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env: { ...testEnv, FASTPATH_WORKSPACE: dir },
      input: JSON.stringify({ prompt: 'AuthService login validateJwt', cwd: dir }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## FastPath \(/);
    assert.doesNotMatch(result.stdout, /OUTPUT MODE = caveman full/);
    assert.doesNotMatch(result.stdout, /CODE MODE = ponytail full/);
    assert.match(result.stdout, /AuthService|validateJwt|login/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt-inject skips code windows for meta; retrieves on question', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-inject-meta-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const meta = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env: { ...testEnv, FASTPATH_WORKSPACE: dir },
      input: JSON.stringify({ prompt: 'commit these changes', cwd: dir }),
    });
    assert.equal(meta.status, 0, meta.stderr);
    assert.match(meta.stdout, /session\/meta — no code windows/);
    assert.doesNotMatch(meta.stdout, /```/);
    assert.doesNotMatch(meta.stdout, /Routing advisor/);

    const question = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env: { ...testEnv, FASTPATH_WORKSPACE: dir },
      input: JSON.stringify({
        prompt: 'how does authentication work in general',
        cwd: dir,
      }),
    });
    assert.equal(question.status, 0, question.stderr);
    assert.match(question.stdout, /## FastPath/);
    assert.doesNotMatch(question.stdout, /no code windows/);
    assert.doesNotMatch(question.stdout, /session\/meta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
