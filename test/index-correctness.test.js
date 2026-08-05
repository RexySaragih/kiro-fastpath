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

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

test('branch switch is reconciled from head_sha, not the working tree', async () => {
  const { indexWorkspace, indexHeadChange, searchIndex, lookupSymbol } = await core();
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'a.ts'), 'export function onMain() { return 1; }\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'main');
    await indexWorkspace(dir);
    assert.ok(lookupSymbol(dir, 'onMain').length > 0);

    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'a.ts'), 'export function onOther() { return 2; }\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'other');

    // Working tree is clean, so status-based delta sees nothing.
    const result = await indexHeadChange(dir);
    assert.notEqual(result.from, result.to);
    assert.ok(result.filesIndexed >= 1);
    assert.ok(lookupSymbol(dir, 'onOther').length > 0);
    assert.equal(lookupSymbol(dir, 'onMain').length, 0);
    void searchIndex;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dirty scan uses git candidates and still catches edits', async () => {
  const { indexWorkspace, findDirtyFiles } = await core();
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    await indexWorkspace(dir);
    assert.deepEqual(findDirtyFiles(dir), []);

    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');
    const dirty = findDirtyFiles(dir);
    assert.ok(dirty.some((p) => p.includes('app.ts')), dirty.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text-only extensions are indexed for search without symbols', async () => {
  const { indexWorkspace, searchIndex, openDatabase, resolveDbPath } = await core();
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-textonly-'));
  try {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      join(dir, 'config/deploy.yaml'),
      'service:\n  name: billing-worker\n  replicas: 3\n',
    );
    writeFileSync(join(dir, 'NOTES.md'), '# Runbook\n\nRotate the billing worker weekly.\n');
    await indexWorkspace(dir);

    const hits = await searchIndex(dir, 'billing worker', { topK: 5 });
    assert.ok(hits.some((h) => h.path.endsWith('.yaml') || h.path.endsWith('.md')));

    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const symbols = db.prepare(`SELECT COUNT(*) AS c FROM symbols`).get().c;
      assert.equal(symbols, 0, 'text-only files must not produce symbols');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous call targets resolve via import proximity', async () => {
  const { indexWorkspace, openDatabase, resolveDbPath } = await core();
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-calls-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/left.ts'), 'export function handle() { return 1; }\n');
    writeFileSync(join(dir, 'src/right.ts'), 'export function handle() { return 2; }\n');
    writeFileSync(
      join(dir, 'src/caller.ts'),
      "import { handle } from './left.js';\nexport function run() { return handle(); }\n",
    );
    await indexWorkspace(dir);

    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const row = db
        .prepare(
          `SELECT to_path FROM call_edges WHERE from_path = 'src/caller.ts' AND to_name = 'handle'`,
        )
        .get();
      assert.ok(row, 'call edge missing');
      // Previously stayed NULL forever because two symbols shared the name.
      assert.equal(row.to_path, 'src/left.ts');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
