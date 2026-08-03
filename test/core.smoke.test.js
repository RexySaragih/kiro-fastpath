import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, '..');

test('index + search sample workspace', async () => {
  const { indexWorkspace, searchIndex, lookupSymbol, contextForTask } =
    await import(join(repoRoot, 'packages/core/dist/index.js'));

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-'));
  try {
    cpSync(join(repoRoot, 'fixtures/sample-src'), join(dir, 'src'), {
      recursive: true,
    });
    const result = await indexWorkspace(dir);
    assert.ok(result.stats.files >= 2);
    assert.ok(result.stats.symbols >= 3);

    const authHits = await searchIndex(dir, 'authenticateUser');
    assert.ok(authHits.some((h) => h.symbol === 'authenticateUser' || h.path.includes('auth')));

    const symbols = lookupSymbol(dir, 'AuthService');
    assert.ok(symbols.some((h) => h.symbol === 'AuthService'));

    const ctx = await contextForTask(dir, 'login authentication jwt');
    assert.ok(ctx.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
