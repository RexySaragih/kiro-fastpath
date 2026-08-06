/**
 * Behavioral tests: focused code windows on find/impact/window MCP paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');
const inject = join(root, 'packages/cli/dist/prompt-inject.js');

function makeEnv(userDir, extra = {}) {
  return {
    ...process.env,
    FASTPATH_EMBED: 'hash',
    FASTPATH_RERANK: 'off',
    FASTPATH_PARSER: 'legacy',
    FASTPATH_ALLOW_HASH: '1',
    FASTPATH_USER_DIR: userDir,
    ...extra,
  };
}

test('find/symbol hits include startLine/endLine and body containing the symbol', async () => {
  const { indexWorkspace, lookupSymbol, searchIndex } = await import(
    join(root, 'packages/core/dist/index.js')
  );
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-win-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const symbols = lookupSymbol(dir, 'validateJwt', { topK: 3 });
    assert.ok(symbols.length > 0, 'expected symbol hits');
    const hit = symbols[0];
    assert.ok(hit.startLine != null && hit.endLine != null, 'missing window range');
    assert.ok(hit.endLine >= hit.startLine);
    assert.match(hit.snippet, /validateJwt/);

    const search = await searchIndex(dir, 'AuthService', { topK: 5 });
    assert.ok(search.some((h) => h.startLine != null && h.snippet.includes('AuthService')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWindow returns slice and rejects path escape', async () => {
  const { indexWorkspace, readWindow } = await import(
    join(root, 'packages/core/dist/index.js')
  );
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-rw-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/sample.ts'),
      'line1\nline2\nline3\nline4\nline5\n',
    );
    await indexWorkspace(dir);

    const win = readWindow(dir, 'src/sample.ts', 2, 4);
    assert.equal(win.startLine, 2);
    assert.equal(win.endLine, 4);
    assert.match(win.body, /line2/);
    assert.match(win.body, /line4/);
    assert.doesNotMatch(win.body, /line5/);

    assert.throws(() => readWindow(dir, '../outside.ts', 1, 2), /escape|Invalid/i);
    assert.throws(() => readWindow(dir, '/etc/passwd', 1, 2), /escape|Invalid/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP window tool returns exact slice', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const { handleWindow } = await import(
    join(root, 'packages/mcp-server/dist/tools/window.js')
  );

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-mcpw-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'aaa\nbbb\nccc\n');
    await indexWorkspace(dir);

    process.env.FASTPATH_WORKSPACE = dir;
    const res = handleWindow({ path: 'src/a.ts', start_line: 1, end_line: 2 });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.match(res.content[0].text, /aaa/);
    assert.match(res.content[0].text, /bbb/);
    assert.doesNotMatch(res.content[0].text, /ccc/);
  } finally {
    delete process.env.FASTPATH_WORKSPACE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install wires resources + caveman; inject emits path ranges', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-wire-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-wireu-'));
  const env = makeEnv(userDir, { FASTPATH_HOME: root, FASTPATH_WORKSPACE: dir });
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const install = spawnSync(process.execPath, [cli, 'install-kiro', dir], {
      encoding: 'utf8',
      env,
    });
    assert.equal(install.status, 0, install.stdout + install.stderr);

    const scout = readFileSync(join(dir, '.kiro/agents/Scout.md'), 'utf8');
    assert.match(scout, /\.kiro\/steering\/\*\*\/\*\.md/);
    assert.match(scout, /skill:\/\/\.kiro\/skills\/caveman\/SKILL\.md/);
    assert.match(scout, /skill:\/\/\.kiro\/skills\/ponytail\/SKILL\.md/);
    assert.match(scout, /- window\n/);
    assert.match(scout, /OUTPUT MODE = caveman full/);
    assert.match(scout, /CODE MODE = ponytail full/);
    assert.match(scout, /at most 5 distinct files/);
    assert.doesNotMatch(scout, /\bcapability:\s*shell\b[\s\S]*effect:\s*allow/);

    const caveman = readFileSync(join(dir, '.kiro/steering/caveman.md'), 'utf8');
    assert.match(caveman, /Caveman full/);
    assert.match(caveman, /ACTIVE EVERY RESPONSE/);
    assert.ok(existsSync(join(dir, '.kiro/skills/caveman/SKILL.md')));
    assert.ok(existsSync(join(dir, '.kiro/steering/ponytail.md')));
    assert.ok(existsSync(join(dir, '.kiro/skills/ponytail/SKILL.md')));

    const inj = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        prompt: 'where is AuthService login validation',
        cwd: dir,
        workspace_roots: [dir],
      }),
    });
    assert.equal(inj.status, 0, inj.stderr);
    assert.match(inj.stdout, /FastPath retrieved context/);
    assert.match(inj.stdout, /:\d+(-\d+)?`/);
    assert.match(inj.stdout, /window/);

    const doctor = spawnSync(process.execPath, [cli, 'doctor', dir], {
      encoding: 'utf8',
      env,
    });
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /Caveman full/);
    assert.match(doctor.stdout, /loads steering via resources/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});
