/**
 * Prefs + memory settings: CLI resolve/set, presets, pin/wipe, capture hook flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
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

test('modes preset quiet + reset clears workspace override', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-prefs-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-prefs-ws-'));
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

    const preset = run(['modes', 'preset', 'quiet', ws], env);
    assert.equal(preset.status, 0, preset.stderr + preset.stdout);
    assert.match(preset.stdout, /Preset quiet/);
    const snap = JSON.parse(run(['modes', ws, '--json'], env).stdout);
    assert.equal(snap.effective.caveman, 'ultra');
    assert.equal(snap.effective.ponytail, 'ultra');
    assert.match(
      readFileSync(join(ws, 'AGENTS.md'), 'utf8'),
      /OUTPUT MODE = caveman ultra/,
    );

    const reset = run(['modes', 'reset', ws], env);
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    const snap2 = JSON.parse(run(['modes', ws, '--json'], env).stdout);
    assert.equal(snap2.workspace.caveman, undefined);
    assert.equal(snap2.effective.caveman, 'full');
  } finally {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('memory settings set pin wipe and capture disables hook', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-memset-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-memset-ws-'));
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

    const settings = run(['memory', 'settings', ws, '--json'], env);
    assert.equal(settings.status, 0, settings.stderr);
    const s0 = JSON.parse(settings.stdout);
    assert.equal(s0.effective.sessionMax, 50);
    assert.equal(s0.effective.capture, true);

    const setCap = run(['memory', 'set', 'sessionMax', '10', ws], env);
    assert.equal(setCap.status, 0, setCap.stderr);
    const s1 = JSON.parse(run(['memory', 'settings', ws, '--json'], env).stdout);
    assert.equal(s1.effective.sessionMax, 10);
    assert.equal(s1.workspace.sessionMax, 10);

    const { saveMemory, listMemories, pinMemory, wipeMemories, setMemoryLimits } =
      await import('../packages/core/dist/index.js');
    setMemoryLimits({ sessionMax: 10, autoPrune: true });
    const a = await saveMemory(ws, { kind: 'session', text: 'temp session note' });
    const b = await saveMemory(ws, { kind: 'decision', text: 'keep this decision' });
    pinMemory(ws, b.id);

    const pinCli = run(['memory', 'pin', String(a.id), ws], env);
    assert.equal(pinCli.status, 0, pinCli.stderr);
    assert.match(pinCli.stdout, /Pinned/);

    const wipeNo = run(['memory', 'wipe', ws], env);
    assert.equal(wipeNo.status, 1);
    assert.match(wipeNo.stderr, /--yes/);

    const wipeSess = run(['memory', 'wipe', '--kind', 'session', ws, '--yes'], env);
    assert.equal(wipeSess.status, 0, wipeSess.stderr);
    // pinned session a should survive wipe
    const after = listMemories(ws);
    assert.ok(after.some((m) => m.id === a.id));
    assert.ok(after.some((m) => m.id === b.id));

    const wiped = wipeMemories(ws, { kind: 'all' });
    assert.equal(wiped, 0); // both pinned
    const unpin = run(['memory', 'unpin', String(a.id), ws], env);
    assert.equal(unpin.status, 0);
    const wipeAll = run(['memory', 'wipe', '--kind', 'all', ws, '--yes'], env);
    assert.equal(wipeAll.status, 0, wipeAll.stderr);
    assert.match(wipeAll.stdout, /Wiped 1/);
    assert.ok(listMemories(ws).some((m) => m.id === b.id));

    const capOff = run(['memory', 'set', 'capture', 'false', ws], env);
    assert.equal(capOff.status, 0, capOff.stderr + capOff.stdout);
    const hooks = JSON.parse(
      readFileSync(join(ws, '.kiro/hooks/fastpath-context.json'), 'utf8'),
    );
    const capture = hooks.hooks.find((h) => h.name === 'fastpath-memory-capture');
    assert.equal(capture.enabled, false);

    const scout = readFileSync(join(ws, '.kiro/agents/Scout.md'), 'utf8');
    assert.match(scout, /\/effort low/);
  } finally {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
