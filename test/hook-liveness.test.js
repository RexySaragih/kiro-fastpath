import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = join(root, 'packages/cli/dist/prompt-inject.js');

const baseEnv = {
  ...process.env,
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

test('installed hook matchers compile as JS RegExp', async () => {
  const { findInvalidHookMatchers } = await import(join(root, 'packages/cli/dist/doctor.js'));
  const shipped = JSON.parse(
    readFileSync(join(root, 'packages/agent-pack/hooks/fastpath-context.json'), 'utf8'),
  );
  assert.deepEqual(findInvalidHookMatchers(shipped.hooks), []);
  for (const hook of shipped.hooks) {
    if (hook.matcher) assert.doesNotThrow(() => new RegExp(hook.matcher));
  }
  // The historical bug: inline flags are a JS RegExp syntax error.
  const bad = findInvalidHookMatchers([{ name: 'x', matcher: '(?i)(glob)' }]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /inline flags/);
});

test('guardrail matcher still matches the tool names it must catch', () => {
  const shipped = JSON.parse(
    readFileSync(join(root, 'packages/agent-pack/hooks/fastpath-context.json'), 'utf8'),
  );
  const guardrail = shipped.hooks.find((h) => h.trigger === 'PreToolUse');
  const re = new RegExp(guardrail.matcher);
  for (const tool of [
    'listDirectory',
    'list_directory',
    'file_search',
    'glob',
    'findFiles',
    'execute_bash',
    'executeBash',
    'shell',
  ]) {
    assert.equal(re.test(tool), true, `matcher missed ${tool}`);
  }
});

test('file-event matchers cover every INDEXABLE_EXTENSIONS entry', async () => {
  const { INDEXABLE_EXTENSIONS } = await import(join(root, 'packages/core/dist/index.js'));
  const shipped = JSON.parse(
    readFileSync(join(root, 'packages/agent-pack/hooks/fastpath-context.json'), 'utf8'),
  );
  for (const hook of shipped.hooks.filter((h) =>
    ['PostFileSave', 'PostFileCreate', 'PostFileDelete'].includes(h.trigger),
  )) {
    const re = new RegExp(hook.matcher);
    for (const ext of INDEXABLE_EXTENSIONS) {
      assert.equal(re.test(`foo${ext}`), true, `${hook.name} missed ${ext}`);
    }
  }
  const create = shipped.hooks.find((h) => h.name === 'fastpath-file-create');
  assert.match(create.action.command, /FILE_EVENT_CREATE/);
});

test('prompt-inject emits a recency pack instead of an empty block', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-recency-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  try {
    writeFileSync(
      join(dir, 'thing.ts'),
      'export function computeThing() { return 42; }\n',
    );
    await indexWorkspace(dir);

    const result = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env: { ...baseEnv, FASTPATH_WORKSPACE: dir, FASTPATH_USER_DIR: userDir },
      input: JSON.stringify({ cwd: dir }), // no prompt field
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /skip retrieval/);
    assert.match(result.stdout, /recency pack/i);
    assert.match(result.stdout, /computeThing/);

    // Heartbeat proves the hook actually ran (liveness-based readiness).
    const beats = JSON.parse(readFileSync(join(userDir, 'heartbeats.json'), 'utf8'));
    assert.ok(beats.hooks['prompt-inject'].count >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('FASTPATH_HOOK_DEBUG captures the raw payload contract', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-hookdbg-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    await indexWorkspace(dir);

    const result = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        FASTPATH_WORKSPACE: dir,
        FASTPATH_USER_DIR: userDir,
        FASTPATH_HOOK_DEBUG: '1',
      },
      input: JSON.stringify({ prompt: 'where is a', cwd: dir, mystery_field: 7 }),
    });
    assert.equal(result.status, 0, result.stderr);

    const logPath = join(userDir, 'hook-payloads.jsonl');
    assert.equal(existsSync(logPath), true);
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop());
    assert.equal(entry.hook, 'prompt-inject');
    assert.ok(entry.payloadKeys.includes('mystery_field'));
    assert.ok(Array.isArray(entry.envKeys));
    // Env values are never recorded — key names only.
    assert.equal(JSON.stringify(entry).includes('FASTPATH_WORKSPACE='), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('hook liveness reports never-fired hooks as unverified', async () => {
  const { checkHookLiveness } = await import(join(root, 'packages/cli/dist/doctor.js'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  const prior = process.env.FASTPATH_USER_DIR;
  try {
    process.env.FASTPATH_USER_DIR = userDir;
    const empty = checkHookLiveness();
    assert.equal(empty.verified, false);
    assert.ok(empty.never.includes('prompt-inject'));

    writeFileSync(
      join(userDir, 'heartbeats.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            'prompt-inject',
            'session-start',
            'file-save',
            'file-create',
            'file-delete',
            'memory-capture',
            'guardrail',
          ].map((h) => [h, { lastAt: new Date().toISOString(), count: 1 }]),
        ),
      }),
    );
    assert.equal(checkHookLiveness().verified, true);

    writeFileSync(
      join(userDir, 'heartbeats.json'),
      JSON.stringify({
        hooks: { 'prompt-inject': { lastAt: '2000-01-01T00:00:00.000Z', count: 1 } },
      }),
    );
    const stale = checkHookLiveness();
    assert.equal(stale.verified, false);
    assert.ok(stale.stale.includes('prompt-inject'));
  } finally {
    if (prior === undefined) delete process.env.FASTPATH_USER_DIR;
    else process.env.FASTPATH_USER_DIR = prior;
    rmSync(userDir, { recursive: true, force: true });
  }
});
