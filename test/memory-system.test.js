import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function core() {
  return import(join(root, 'packages/core/dist/index.js'));
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-mem-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

test('near-duplicate memories consolidate instead of stacking', async () => {
  const { saveMemory, listMemories } = await core();
  const dir = workspace();
  try {
    await saveMemory(dir, { kind: 'decision', text: 'We use MiniLM embeddings for retrieval.' });
    await saveMemory(dir, { kind: 'decision', text: 'We use MiniLM embeddings for retrieval.' });
    await saveMemory(dir, {
      kind: 'decision',
      text: 'We use MiniLM embeddings for retrieval quality.',
    });
    const all = listMemories(dir).filter((m) => m.kind === 'decision');
    assert.ok(all.length <= 2, `expected consolidation, got ${all.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall boosts memories scoped to the current paths', async () => {
  const { saveMemory, recallMemories } = await core();
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'src/auth.ts'), 'export const auth = 1;\n');
    writeFileSync(join(dir, 'src/ui.ts'), 'export const ui = 1;\n');
    await saveMemory(dir, {
      kind: 'fact',
      text: 'Backend guards every route with a bearer token check.',
      paths: ['src/auth.ts'],
    });
    await saveMemory(dir, {
      kind: 'fact',
      text: 'Frontend renders the dashboard grid with CSS subgrid.',
      paths: ['src/ui.ts'],
    });

    const scoped = await recallMemories(dir, 'guard route token', {
      topK: 1,
      scopePaths: ['src/auth.ts'],
    });
    assert.equal(scoped.length, 1);
    assert.match(scoped[0].text, /bearer token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memories go stale when their referenced files change', async () => {
  const { saveMemory, recallMemories } = await core();
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'src/auth.ts'), 'export function validateJwt() { return true; }\n');
    await saveMemory(dir, {
      kind: 'fact',
      text: 'validateJwt always returns true in dev mode.',
      paths: ['src/auth.ts'],
    });

    let hits = await recallMemories(dir, 'validateJwt dev mode', { topK: 1 });
    assert.equal(hits[0].stale, false);

    writeFileSync(join(dir, 'src/auth.ts'), 'export function validateJwt() { return false; }\n');
    hits = await recallMemories(dir, 'validateJwt dev mode', { topK: 1 });
    assert.equal(hits[0].stale, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall uses ANN candidates, not a full table scan', async () => {
  const { saveMemory, recallMemories, openDatabase, resolveDbPath } = await core();
  const dir = workspace();
  try {
    for (let i = 0; i < 12; i++) {
      await saveMemory(dir, { kind: 'fact', text: `Fact number ${i} about module ${i}.` });
    }
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const buckets = db.prepare(`SELECT COUNT(*) AS c FROM memory_lsh`).get().c;
      assert.ok(buckets > 0, 'memory LSH buckets not populated');
    } finally {
      db.close();
    }
    const hits = await recallMemories(dir, 'module 7', { topK: 2 });
    assert.ok(hits.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session memory names changed symbols, not just files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-capture-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-userdir-'));
  const capture = join(root, 'packages/cli/dist/memory-capture.js');
  const inject = join(root, 'packages/cli/dist/prompt-inject.js');
  const env = {
    ...process.env,
    FASTPATH_EMBED: 'hash',
    FASTPATH_RERANK: 'off',
    FASTPATH_PARSER: 'legacy',
    FASTPATH_ALLOW_HASH: '1',
    FASTPATH_USER_DIR: userDir,
    FASTPATH_WORKSPACE: dir,
  };
  try {
    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/auth.ts'),
      'export function validateJwt() {\n  return true;\n}\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'init');

    const { indexWorkspace, listMemories } = await core();
    await indexWorkspace(dir);

    // Prime lastPrompt + touchedPaths the way the hooks would.
    spawnSync(process.execPath, [inject], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ prompt: 'harden jwt validation', cwd: dir }),
    });
    writeFileSync(
      join(dir, 'src/auth.ts'),
      'export function validateJwt() {\n  return Date.now() > 0;\n}\n',
    );
    spawnSync(process.execPath, [join(root, 'packages/cli/dist/file-event.js')], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ file_path: join(dir, 'src/auth.ts'), cwd: dir }),
    });
    const stop = spawnSync(process.execPath, [capture], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ cwd: dir }),
    });
    assert.equal(stop.status, 0, stop.stderr);

    const memories = listMemories(dir).filter((m) => m.kind === 'session');
    assert.ok(memories.length > 0, 'no session memory saved');
    assert.match(memories[0].text, /validateJwt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});
