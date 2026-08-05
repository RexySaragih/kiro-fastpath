import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guardrail = join(root, 'packages/cli/dist/guardrail.js');

const baseEnv = {
  ...process.env,
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

test('scoped walks are allowed, unscoped walks are not', async () => {
  const { isScopedWalk, readWalkRequest } = await import(
    join(root, 'packages/cli/dist/guardrail-policy.js')
  );

  assert.equal(isScopedWalk({ path: 'src/auth', depth: 1 }), true);
  assert.equal(isScopedWalk({ path: 'src/auth', depth: null }), true);
  assert.equal(isScopedWalk({ path: 'src/auth', depth: 3 }), false);
  assert.equal(isScopedWalk({ path: '.', depth: 1 }), false);
  assert.equal(isScopedWalk({ path: '', depth: null }), false);
  assert.equal(isScopedWalk({ path: '**/*.ts', depth: null }), false);

  // Argument shape varies by Kiro version.
  assert.deepEqual(readWalkRequest({ tool_input: { path: 'src', depth: 2 } }), {
    path: 'src',
    depth: 2,
  });
  assert.equal(readWalkRequest({ arguments: { directory: 'lib' } }).path, 'lib');
});

test('shell discovery detects repo greps but allows stdout filters', async () => {
  const { isRepoDiscoveryShell, isShellTool, readShellCommand } = await import(
    join(root, 'packages/cli/dist/guardrail-policy.js')
  );

  assert.equal(isShellTool('execute_bash'), true);
  assert.equal(isShellTool('Shell'), true);
  assert.equal(isShellTool('listDirectory'), false);

  assert.equal(isRepoDiscoveryShell('grep -rln "(?i)" .'), true);
  assert.equal(isRepoDiscoveryShell('grep -n pattern src/'), true);
  assert.equal(isRepoDiscoveryShell('rg "matcher" packages'), true);
  assert.equal(isRepoDiscoveryShell('rg pattern'), true);
  assert.equal(isRepoDiscoveryShell('find . -name "*.ts"'), true);
  assert.equal(isRepoDiscoveryShell('git grep TODO'), true);

  assert.equal(isRepoDiscoveryShell('npm test 2>&1 | rg "not ok"'), false);
  assert.equal(isRepoDiscoveryShell('grep -n pattern src/app.ts'), false);
  assert.equal(isRepoDiscoveryShell('rg foo packages/cli/src/guardrail.ts'), false);
  assert.equal(isRepoDiscoveryShell('git status --porcelain'), false);

  assert.equal(
    readShellCommand({ tool_name: 'execute_bash', tool_input: { command: 'rg x .' } }),
    'rg x .',
  );
});

test('recursive shell discovery is blocked; stdout filter is allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-guard-shell-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  try {
    const env = { ...baseEnv, FASTPATH_WORKSPACE: dir, FASTPATH_USER_DIR: userDir };

    const blocked = spawnSync(process.execPath, [guardrail], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        tool_name: 'execute_bash',
        session_id: 'sshell',
        cwd: dir,
        tool_input: { command: 'grep -rln matcher .' },
      }),
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /recursive shell search/);
    assert.match(blocked.stderr, /find.*mode: grep/i);

    const allowed = spawnSync(process.execPath, [guardrail], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        tool_name: 'execute_bash',
        session_id: 'sshell',
        cwd: dir,
        tool_input: { command: 'npm test 2>&1 | grep "not ok"' },
      }),
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('blocked walk is answered with the indexed file list', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-guard-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  try {
    mkdirSync(join(dir, 'src/auth'), { recursive: true });
    writeFileSync(join(dir, 'src/auth/guard.ts'), 'export const guard = 1;\n');
    writeFileSync(join(dir, 'src/auth/token.ts'), 'export const token = 1;\n');
    await indexWorkspace(dir);

    const blocked = spawnSync(process.execPath, [guardrail], {
      encoding: 'utf8',
      env: { ...baseEnv, FASTPATH_WORKSPACE: dir, FASTPATH_USER_DIR: userDir },
      input: JSON.stringify({
        tool_name: 'listDirectory',
        session_id: 's1',
        cwd: dir,
        tool_input: { path: 'src', depth: 5 },
      }),
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /from FastPath index/);
    assert.match(blocked.stderr, /src\/auth\/guard\.ts/);

    const allowed = spawnSync(process.execPath, [guardrail], {
      encoding: 'utf8',
      env: { ...baseEnv, FASTPATH_WORKSPACE: dir, FASTPATH_USER_DIR: userDir },
      input: JSON.stringify({
        tool_name: 'listDirectory',
        session_id: 's1',
        cwd: dir,
        tool_input: { path: 'src/auth', depth: 1 },
      }),
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('repeated reads of one file warn without blocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-guard-read-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  try {
    const payload = JSON.stringify({
      tool_name: 'readFile',
      session_id: 'sread',
      cwd: dir,
      tool_input: { path: 'src/app.ts' },
    });
    const env = { ...baseEnv, FASTPATH_WORKSPACE: dir, FASTPATH_USER_DIR: userDir };
    const run = () =>
      spawnSync(process.execPath, [guardrail], { encoding: 'utf8', env, input: payload });

    assert.equal(run().stderr.includes('already read'), false);
    run();
    const third = run();
    assert.equal(third.status, 0);
    assert.match(third.stderr, /already read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});
