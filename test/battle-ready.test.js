import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');

const env = {
  ...process.env,
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

function fixtureWs() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-br-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), 'export function alpha() { return beta(); }\nfunction beta(){return 1}\n');
  return dir;
}

test('schema version + integrity + busy_timeout exported', async () => {
  const {
    CURRENT_SCHEMA_VERSION,
    SQLITE_BUSY_TIMEOUT_MS,
    openDatabase,
    resolveDbPath,
    getSchemaVersion,
    checkDatabaseIntegrity,
    indexWorkspace,
  } = await import(join(root, 'packages/core/dist/index.js'));
  assert.equal(CURRENT_SCHEMA_VERSION, 7);
  assert.ok(SQLITE_BUSY_TIMEOUT_MS >= 1000);

  const dir = fixtureWs();
  try {
    await indexWorkspace(dir);
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      assert.equal(getSchemaVersion(db), CURRENT_SCHEMA_VERSION);
      const integrity = checkDatabaseIntegrity(db);
      assert.equal(integrity.ok, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('index --rebuild recreates DB', () => {
  const dir = fixtureWs();
  try {
    assert.equal(spawnSync(process.execPath, [cli, 'init', dir], { encoding: 'utf8', env }).status, 0);
    assert.equal(spawnSync(process.execPath, [cli, 'index', dir], { encoding: 'utf8', env }).status, 0);
    const dbPath = join(dir, '.fastpath', 'index.db');
    assert.ok(existsSync(dbPath));
    const before = readFileSync(dbPath);
    const rebuild = spawnSync(process.execPath, [cli, 'index', dir, '--rebuild'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(rebuild.status, 0, rebuild.stderr + rebuild.stdout);
    assert.match(rebuild.stdout, /rebuild|Indexing/);
    assert.ok(existsSync(dbPath));
    assert.ok(readFileSync(dbPath).length > 0);
    void before;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unwire removes agents/hook/mcp entry', () => {
  const dir = fixtureWs();
  try {
    assert.equal(spawnSync(process.execPath, [cli, 'init', dir], { encoding: 'utf8', env }).status, 0);
    assert.equal(spawnSync(process.execPath, [cli, 'index', dir], { encoding: 'utf8', env }).status, 0);
    assert.equal(
      spawnSync(process.execPath, [cli, 'install-kiro', dir], { encoding: 'utf8', env }).status,
      0,
    );
    assert.ok(existsSync(join(dir, '.kiro/agents/Scout.md')));
    const unw = spawnSync(process.execPath, [cli, 'unwire', dir], { encoding: 'utf8', env });
    assert.equal(unw.status, 0, unw.stderr + unw.stdout);
    assert.equal(existsSync(join(dir, '.kiro/agents/Scout.md')), false);
    assert.equal(existsSync(join(dir, '.kiro/hooks/fastpath-context.json')), false);
    const mcp = JSON.parse(readFileSync(join(dir, '.kiro/settings/mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers?.fastpath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor --json includes battle-ready fields', () => {
  const dir = fixtureWs();
  try {
    assert.equal(spawnSync(process.execPath, [cli, 'init', dir], { encoding: 'utf8', env }).status, 0);
    assert.equal(spawnSync(process.execPath, [cli, 'index', dir], { encoding: 'utf8', env }).status, 0);
    assert.equal(
      spawnSync(process.execPath, [cli, 'install-kiro', dir], { encoding: 'utf8', env }).status,
      0,
    );
    const doc = spawnSync(process.execPath, [cli, 'doctor', dir, '--json'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(doc.status, 0, doc.stdout + doc.stderr);
    const json = JSON.parse(doc.stdout);
    assert.equal(json.ready, true);
    assert.ok(Array.isArray(json.notes));
    assert.equal(json.schemaVersion, 7);
    assert.equal(json.integrityOk, true);
    assert.equal(json.searchSmokeOk, true);
    assert.ok(json.agentsIdeCompatible);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eval --office passes on fixture', () => {
  const r = spawnSync(process.execPath, [cli, 'eval', '--office'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /office eval passed=/);
});

test('docs pack includes support + release gate', () => {
  assert.ok(existsSync(join(root, 'scripts/SUPPORT_MATRIX.txt')));
  assert.ok(existsSync(join(root, 'scripts/RELEASE_GATE.txt')));
  assert.ok(existsSync(join(root, 'scripts/CHANGELOG.txt')));
  assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"version": "1\.0\.0"/);
});
