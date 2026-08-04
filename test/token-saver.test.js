/**
 * Behavioral tests for the token-saver feature set:
 * memory round-trip, ignore negation, event-hook install wiring,
 * guardrail enforcement, and Stop-hook session capture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
const guardrail = join(root, 'packages/cli/dist/guardrail.js');
const fileEvent = join(root, 'packages/cli/dist/file-event.js');
const memoryCapture = join(root, 'packages/cli/dist/memory-capture.js');
const core = () => import(join(root, 'packages/core/dist/index.js'));

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

function tempWorkspace(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src/auth.ts'),
    'export function login(user: string) { return validateJwt(user); }\nfunction validateJwt(u: string) { return u.length > 0; }\n',
  );
  return dir;
}

test('Memory: save → recall → list → distill → forget round-trip', async () => {
  const { indexWorkspace, saveMemory, recallMemories, listMemories, forgetMemory, distillMemories } =
    await core();
  const dir = tempWorkspace('fastpath-memory-');
  try {
    await indexWorkspace(dir);

    // Given: a saved decision
    const saved = await saveMemory(dir, {
      kind: 'decision',
      text: 'We use JWT tokens for auth sessions instead of cookies',
      tags: ['auth'],
      paths: ['src/auth.ts'],
    });
    assert.ok(saved.id > 0);

    // When: recalled with related words
    const recalled = await recallMemories(dir, 'JWT auth tokens', 3);

    // Then: the decision surfaces and usage is tracked
    assert.equal(recalled.length >= 1, true);
    assert.match(recalled[0].text, /JWT tokens/);

    const listed = listMemories(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].useCount >= 1, true);

    const digest = distillMemories(dir);
    assert.match(digest, /JWT tokens/);
    assert.match(digest, /inclusion: manual/);

    // And: saving identical text dedupes instead of duplicating
    await saveMemory(dir, { kind: 'decision', text: saved.text });
    assert.equal(listMemories(dir).length, 1);

    assert.equal(forgetMemory(dir, saved.id), true);
    assert.equal(listMemories(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ignore: gitignore negation and root anchoring respected', async () => {
  const { IgnoreMatcher } = await core();
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-ignore-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'dist/\n!dist/keep.ts\n/generated\n');
    const matcher = new IgnoreMatcher(dir);

    assert.equal(matcher.ignores(dir, join(dir, 'dist/skip.ts')), true);
    assert.equal(matcher.ignores(dir, join(dir, 'dist/keep.ts')), false);
    // Leading slash anchors to the root — nested dirs of the same name stay indexed.
    assert.equal(matcher.ignores(dir, join(dir, 'generated/x.ts')), true);
    assert.equal(matcher.ignores(dir, join(dir, 'src/generated/x.ts')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ignore: test/ outside src/ stays indexed even when gitignored', async () => {
  const { IgnoreMatcher } = await core();
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-keep-test-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'test/\ntests/\n__tests__/\nspec/\ne2e/\n');
    writeFileSync(
      join(dir, '.fastpathignore'),
      'test/fixtures/\n',
    );
    const matcher = new IgnoreMatcher(dir);

    assert.equal(matcher.ignores(dir, join(dir, 'test/login.test.ts')), false);
    assert.equal(matcher.ignores(dir, join(dir, 'tests/unit.ts')), false);
    assert.equal(matcher.ignores(dir, join(dir, '__tests__/foo.ts')), false);
    assert.equal(matcher.ignores(dir, join(dir, 'spec/bar.ts')), false);
    assert.equal(matcher.ignores(dir, join(dir, 'e2e/flow.ts')), false);
    // .fastpathignore can still drop noisy subtrees under test/
    assert.equal(matcher.ignores(dir, join(dir, 'test/fixtures/blob.bin')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Install: all event hooks + Scout/Architect wired with no placeholders', () => {
  const dir = tempWorkspace('fastpath-hooks-install-');
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-user-'));
  const env = makeEnv(userDir);
  try {
    let r = spawnSync(process.execPath, [cli, 'index', dir], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [cli, 'install-kiro', dir], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const hookRaw = readFileSync(join(dir, '.kiro/hooks/fastpath-context.json'), 'utf8');
    assert.equal(hookRaw.includes('__FASTPATH_'), false);
    const hook = JSON.parse(hookRaw);
    const triggers = hook.hooks.map((h) => h.trigger);
    for (const t of [
      'UserPromptSubmit',
      'SessionStart',
      'PostFileSave',
      'PostFileCreate',
      'PostFileDelete',
      'PreToolUse',
      'Stop',
    ]) {
      assert.ok(triggers.includes(t), `missing trigger ${t}`);
    }
    const del = hook.hooks.find((h) => h.trigger === 'PostFileDelete');
    assert.match(del.action.command, /--delete/);

    const scout = readFileSync(join(dir, '.kiro/agents/Scout.md'), 'utf8');
    assert.match(scout, /name:\s*Scout/);
    assert.match(scout, /claude-sonnet-5/);
    assert.doesNotMatch(scout, /capability:\s*write\b/);
    assert.doesNotMatch(scout, /__FASTPATH_/);
    assert.match(scout, /memory_recall/);
    assert.ok(!existsSync(join(dir, '.kiro/agents/Marshal.md')));

    const doctor = spawnSync(process.execPath, [cli, 'doctor', dir], { encoding: 'utf8', env });
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /Event hooks installed/);
    assert.match(doctor.stdout, /Scout agent installed/);
    assert.match(doctor.stdout, /Architect agent installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('Guardrail: warn logs but allows; block rejects with exit 2; auto blocks after allowance', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-guard-'));
  const payload = JSON.stringify({
    tool_name: 'listDirectory',
    session_id: 'sess-1',
    cwd: tmpdir(),
  });
  const run = (mode) =>
    spawnSync(process.execPath, [guardrail], {
      encoding: 'utf8',
      env: makeEnv(userDir, { FASTPATH_GUARDRAIL: mode }),
      input: payload,
    });
  try {
    assert.equal(run('warn').status, 0);

    const blocked = run('block');
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /FastPath guardrail/);
    assert.match(blocked.stderr, /search \/ symbol \/ grep_fast/);

    assert.equal(run('off').status, 0);

    // auto: allowance consumed by the runs above (same session) → block
    const auto = run('auto');
    assert.equal(auto.status, 2, auto.stderr);

    const log = readFileSync(join(userDir, 'hook-events.jsonl'), 'utf8');
    assert.match(log, /listDirectory/);
    assert.match(log, /"payloadKeys"/);
  } finally {
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('File event → Stop capture: edited files become one session memory', async () => {
  const { indexWorkspace, listMemories } = await core();
  const dir = tempWorkspace('fastpath-capture-');
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-capuser-'));
  const env = makeEnv(userDir, { FASTPATH_WORKSPACE: dir });
  try {
    await indexWorkspace(dir);

    // Given: a prompt was seen (records lastPrompt state)
    let r = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ prompt: 'fix login bug', cwd: dir }),
    });
    assert.equal(r.status, 0, r.stderr);

    // And: the agent saved a file (file-event hook indexes + records touch)
    writeFileSync(
      join(dir, 'src/auth.ts'),
      'export function login(user: string) { return !!user; }\n',
    );
    r = spawnSync(process.execPath, [fileEvent], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ file_path: join(dir, 'src/auth.ts'), cwd: dir }),
    });
    assert.equal(r.status, 0, r.stderr);

    // When: the turn ends (Stop hook)
    r = spawnSync(process.execPath, [memoryCapture], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ cwd: dir }),
    });
    assert.equal(r.status, 0, r.stderr);

    // Then: one session memory exists tying the task to the file
    const memories = listMemories(dir);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].kind, 'session');
    assert.match(memories[0].text, /fix login bug/);
    assert.match(memories[0].text, /auth\.ts/);

    // And: a second Stop with no new edits saves nothing
    r = spawnSync(process.execPath, [memoryCapture], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ cwd: dir }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(listMemories(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('Prompt inject: routing hint appears for multi-file asks, memories injected', async () => {
  const { indexWorkspace, saveMemory } = await core();
  const dir = tempWorkspace('fastpath-hint-');
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-hintuser-'));
  const env = makeEnv(userDir, { FASTPATH_WORKSPACE: dir });
  try {
    await indexWorkspace(dir);
    await saveMemory(dir, {
      kind: 'decision',
      text: 'login validation uses validateJwt from src/auth.ts',
    });

    const result = spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        prompt: 'refactor the login validation architecture across the system',
        cwd: dir,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Routing: multi-file scope likely/);
    assert.match(result.stdout, /FastPath memory/);
    assert.match(result.stdout, /validateJwt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('Session start: reports index status and recent memory', async () => {
  const { indexWorkspace, saveMemory } = await core();
  const sessionStart = join(root, 'packages/cli/dist/session-start.js');
  const dir = tempWorkspace('fastpath-session-');
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-sessuser-'));
  const env = makeEnv(userDir, { FASTPATH_WORKSPACE: dir });
  try {
    await indexWorkspace(dir);
    await saveMemory(dir, { kind: 'fact', text: 'auth module lives in src/auth.ts' });

    const result = spawnSync(process.execPath, [sessionStart], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ cwd: dir }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FastPath session/);
    assert.match(result.stdout, /Recent project memory/);
    assert.match(result.stdout, /auth module/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test('MCP: memory_save and memory_recall handlers round-trip', async () => {
  const { indexWorkspace } = await core();
  const mod = await import(join(root, 'packages/mcp-server/dist/tools/memory.js'));
  const { FastpathClient } = await import(
    join(root, 'packages/mcp-server/dist/clients/fastpath-client.js')
  );
  const dir = tempWorkspace('fastpath-mcpmem-');
  try {
    await indexWorkspace(dir);
    const client = new FastpathClient(dir);

    assert.equal((await mod.handleMemorySave(client, {})).isError, true);

    const saved = await mod.handleMemorySave(client, {
      kind: 'fact',
      text: 'FTS index covers memories table',
      tags: ['index'],
    });
    assert.notEqual(saved.isError, true);
    assert.match(saved.content[0].text, /Saved memory #\d+/);

    const recalled = await mod.handleMemoryRecall(client, { query: 'memories FTS index' });
    assert.notEqual(recalled.isError, true);
    assert.match(recalled.content[0].text, /FTS index covers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
