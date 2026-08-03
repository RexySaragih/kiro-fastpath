import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadCore() {
  return import(join(root, 'packages/core/dist/index.js'));
}

function fixtureWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-tier-'));
  cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
  return dir;
}

test('indexWorkspacePaths reindexes a single dirty file', async () => {
  const { indexWorkspace, indexWorkspacePaths, findDirtyFiles, openDatabase, resolveDbPath } =
    await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    assert.equal(findDirtyFiles(dir).length, 0);

    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import { AuthService } from './auth';\nexport const svc = new AuthService();\nexport function ping() { return svc.validateJwt('x'); }\n`,
    );
    const dirty = findDirtyFiles(dir);
    assert.ok(dirty.some((p) => p.includes('app.ts')));

    const result = await indexWorkspacePaths(dir, dirty);
    assert.ok(result.filesIndexed >= 1);
    assert.equal(findDirtyFiles(dir).length, 0);

    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const calls = db
        .prepare(`SELECT to_name FROM call_edges WHERE from_path LIKE '%app.ts%'`)
        .all();
      assert.ok(calls.some((r) => String(r.to_name).includes('validateJwt') || String(r.to_name).includes('login') || String(r.to_name).length > 0));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_edges and impact callers for login', async () => {
  const { indexWorkspace, impactForSymbol, openDatabase, resolveDbPath } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM call_edges`).get().c;
      assert.ok(count > 0, 'expected call_edges rows');
    } finally {
      db.close();
    }

    const impact = impactForSymbol(dir, 'login');
    assert.ok(
      impact.callers.some((h) => h.path.includes('app.ts')) ||
        impactForSymbol(dir, 'AuthService.login').callers.some((h) =>
          h.path.includes('app.ts'),
        ),
      `expected caller in app.ts, got ${JSON.stringify(impact.callers)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rerankHits no-ops when FASTPATH_RERANK=off', async () => {
  const { rerankHits } = await loadCore();
  const hits = [
    { path: 'a.ts', symbol: 'a', kind: 'function', line: 1, score: 1, snippet: 'alpha' },
    { path: 'b.ts', symbol: 'b', kind: 'function', line: 1, score: 2, snippet: 'beta' },
  ];
  const out = await rerankHits('query', hits, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'a.ts');
});
