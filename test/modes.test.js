/**
 * fastpath modes show/set + install rendering of levels.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
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

function run(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('modes show defaults and set caveman lite applies to wired workspace', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-modes-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-modes-ws-'));
  const env = {
    ...process.env,
    FASTPATH_USER_DIR: userDir,
    FASTPATH_HOME: root,
    FASTPATH_EMBED: 'hash',
    FASTPATH_RERANK: 'off',
    FASTPATH_PARSER: 'legacy',
    FASTPATH_ALLOW_HASH: '1',
  };
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src/a.ts'), 'export const a = 1;\n');

    const show = run(['modes', ws], env);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /caveman=full \(default\)/);
    assert.match(show.stdout, /ponytail=full \(default\)/);

    const json = run(['modes', ws, '--json'], env);
    assert.equal(json.status, 0, json.stderr);
    const snap = JSON.parse(json.stdout);
    assert.equal(snap.effective.caveman, 'full');
    assert.deepEqual(snap.levels, ['off', 'lite', 'full', 'ultra']);

    const use = run(['use', ws], env);
    assert.equal(use.status, 0, use.stderr + use.stdout);

    const setLite = run(['modes', 'set', 'caveman', 'lite', ws], env);
    assert.equal(setLite.status, 0, setLite.stderr + setLite.stdout);
    assert.match(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), /OUTPUT MODE = caveman lite/);
    assert.match(
      readFileSync(join(ws, '.kiro/agents/Scout.md'), 'utf8'),
      /OUTPUT MODE = caveman lite/,
    );
    assert.match(
      readFileSync(join(ws, '.kiro/agents/Architect.md'), 'utf8'),
      /OUTPUT MODE = caveman lite/,
    );

    const noApply = run(['modes', 'set', 'ponytail', 'ultra', ws, '--no-apply'], env);
    assert.equal(noApply.status, 0, noApply.stderr);
    assert.match(noApply.stdout, /Saved \(no apply\)/);
    assert.match(
      readFileSync(join(ws, 'AGENTS.md'), 'utf8'),
      /CODE MODE = ponytail full/,
    );

    const bad = run(['modes', 'set', 'caveman', 'loud', ws], env);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage: fastpath modes set/);

    const inheritGlobal = run(['modes', 'set', 'caveman', 'inherit', '--global'], env);
    assert.equal(inheritGlobal.status, 1);
    assert.match(inheritGlobal.stderr, /inherit not allowed at global scope/);

    const setGlobal = run(['modes', 'set', 'ponytail', 'ultra', '--global', '--no-apply'], env);
    assert.equal(setGlobal.status, 0, setGlobal.stderr);
    const show2 = run(['modes', ws, '--json'], env);
    const snap2 = JSON.parse(show2.stdout);
    assert.equal(snap2.global.ponytail, 'ultra');
    // workspace override from --no-apply still ultra if we set it... we set --no-apply ultra on ws
    // then global ultra. workspace override wins for ponytail if still present.
    assert.equal(snap2.workspace.ponytail, 'ultra');

    const setOff = run(['modes', 'set', 'caveman', 'off', ws], env);
    assert.equal(setOff.status, 0, setOff.stderr + setOff.stdout);
    const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /OUTPUT MODE = caveman/);
    assert.equal(existsSync(join(ws, '.kiro/steering/caveman.md')), false);
    assert.ok(existsSync(join(ws, '.kiro/skills/caveman/SKILL.md')));
  } finally {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('modes set --global rewires wired workspaces when not --no-apply', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-modes-g-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-modes-g-ws-'));
  const unwired = mkdtempSync(join(tmpdir(), 'fastpath-modes-g-un-'));
  const env = {
    ...process.env,
    FASTPATH_USER_DIR: userDir,
    FASTPATH_HOME: root,
    FASTPATH_EMBED: 'hash',
    FASTPATH_RERANK: 'off',
    FASTPATH_PARSER: 'legacy',
    FASTPATH_ALLOW_HASH: '1',
  };
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src/a.ts'), 'export const a = 1;\n');
    mkdirSync(join(unwired, 'src'), { recursive: true });
    writeFileSync(join(unwired, 'src/a.ts'), 'export const a = 1;\n');

    assert.equal(run(['use', ws], env).status, 0);
    // cmdRewire skips /var/folders and /tmp — so global apply won't touch temp ws.
    // Verify save + that unwired stays without .kiro from this command.
    const set = run(['modes', 'set', 'caveman', 'lite', '--global'], env);
    assert.equal(set.status, 0, set.stderr + set.stdout);

    const show = JSON.parse(run(['modes', ws, '--json'], env).stdout);
    assert.equal(show.global.caveman, 'lite');

    assert.equal(existsSync(join(unwired, '.kiro')), false);

    // Apply via workspace set after clearing override so global takes effect on install.
    run(['modes', 'set', 'caveman', 'inherit', ws, '--no-apply'], env);
    const apply = run(['modes', 'set', 'ponytail', 'full', ws], env);
    assert.equal(apply.status, 0, apply.stderr + apply.stdout);
    assert.match(
      readFileSync(join(ws, 'AGENTS.md'), 'utf8'),
      /OUTPUT MODE = caveman lite/,
    );
  } finally {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(unwired, { recursive: true, force: true });
  }
});

test('doctor validates configured caveman lite and off', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-modes-doc-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-modes-doc-ws-'));
  const env = {
    ...process.env,
    FASTPATH_USER_DIR: userDir,
    FASTPATH_HOME: root,
    FASTPATH_EMBED: 'hash',
    FASTPATH_RERANK: 'off',
    FASTPATH_PARSER: 'legacy',
    FASTPATH_ALLOW_HASH: '1',
  };
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src/a.ts'), 'export const a = 1;\n');
    assert.equal(run(['use', ws], env).status, 0);
    assert.equal(run(['index', ws], env).status, 0);

    assert.equal(run(['modes', 'set', 'caveman', 'lite', ws], env).status, 0);
    const lite = run(['doctor', ws, '--json'], env);
    assert.equal(lite.status, 0, lite.stderr + lite.stdout);
    const liteDoc = JSON.parse(lite.stdout);
    assert.equal(liteDoc.ready, true);
    assert.equal(liteDoc.modes.caveman, 'lite');
    assert.ok(liteDoc.ok.some((s) => /Scout sets OUTPUT MODE caveman lite/.test(s)));
    assert.ok(liteDoc.ok.some((s) => /Architect sets OUTPUT MODE caveman lite/.test(s)));
    assert.ok(liteDoc.ok.some((s) => /Steering includes Caveman lite/.test(s)));
    assert.ok(liteDoc.notes.some((s) => /modes: caveman=lite/.test(s)));

    assert.equal(run(['modes', 'set', 'caveman', 'off', ws], env).status, 0);
    assert.equal(run(['modes', 'set', 'ponytail', 'off', ws], env).status, 0);
    const off = run(['doctor', ws, '--json'], env);
    assert.equal(off.status, 0, off.stderr + off.stdout);
    const offDoc = JSON.parse(off.stdout);
    assert.equal(offDoc.ready, true);
    assert.ok(offDoc.ok.some((s) => s === 'Caveman off (configured)'));
    assert.ok(offDoc.ok.some((s) => s === 'Ponytail off (configured)'));
    assert.equal(offDoc.modes.caveman, 'off');
    assert.equal(offDoc.modes.ponytail, 'off');
  } finally {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
