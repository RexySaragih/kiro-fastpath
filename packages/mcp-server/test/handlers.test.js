import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

test('handlers markdown + validation', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const mod = await import(join(here, '../dist/tools/search.js'));
  const { FastpathClient } = await import(join(here, '../dist/clients/fastpath-client.js'));

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-mcp-test-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    indexWorkspace(dir);
    const client = new FastpathClient(dir);
    assert.equal(mod.handleSearch(client, {}).isError, true);
    assert.match(mod.handleSearch(client, { query: 'AuthService' }).content[0].text, /search/);
    assert.match(mod.handleGrepFast(client, { pattern: 'login' }).content[0].text, /grep/);
    assert.match(mod.handleImpact(client, { name: 'AuthService' }).content[0].text, /impact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
