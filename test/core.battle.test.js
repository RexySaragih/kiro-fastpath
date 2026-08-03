import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadCore() {
  return import(join(root, 'packages/core/dist/index.js'));
}

function fixtureWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-battle-'));
  cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'app.ts'),
    `import { AuthService } from './auth';\nexport const svc = new AuthService();\n`,
  );
  return dir;
}

test('hybrid search finds auth and python tax', async () => {
  const { indexWorkspace, searchIndex, lookupSymbol } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    assert.ok((await searchIndex(dir, 'login authentication')).length > 0);
    assert.ok(lookupSymbol(dir, 'calculate_tax').some((h) => h.symbol === 'calculate_tax'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep_fast finds validateJwt via ngram prefilter', async () => {
  const { indexWorkspace, grepFast } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    const hits = grepFast(dir, 'validateJwt');
    assert.ok(hits.some((h) => h.path.includes('auth')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('impact reports importers for AuthService module', async () => {
  const { indexWorkspace, impactForSymbol } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    const impact = impactForSymbol(dir, 'AuthService');
    assert.ok(impact.definitions.length > 0);
    assert.ok(
      impact.importers.some((h) => h.path.includes('app.ts')) ||
        impact.references.some((h) => h.path.includes('app.ts')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental index skips unchanged files', async () => {
  const { indexWorkspace } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    const first = await indexWorkspace(dir);
    const second = await indexWorkspace(dir);
    assert.ok(first.filesIndexed >= 2);
    assert.equal(second.filesIndexed, 0);
    assert.ok(second.filesSkipped >= first.filesIndexed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignore excludes node_modules', async () => {
  const { indexWorkspace, getIndexStats } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'export const x = 1;\n');
    await indexWorkspace(dir);
    const stats = getIndexStats(dir);
    assert.ok(stats.files < 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LSH rows created for vectors', async () => {
  const { indexWorkspace, openDatabase, resolveDbPath } = await loadCore();
  const dir = fixtureWorkspace();
  try {
    await indexWorkspace(dir);
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const c = (db.prepare(`SELECT COUNT(*) AS c FROM vector_lsh`).get()).c;
      assert.ok(c > 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
