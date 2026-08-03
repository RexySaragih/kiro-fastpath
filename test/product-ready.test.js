import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');

async function loadCore() {
  return import(join(root, 'packages/core/dist/index.js'));
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-pr-'));
  cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
  return dir;
}

test('symbol filter drops ClassName.localConst junk; keeps methods', async () => {
  const { parseTypeScript, lookupSymbol, indexWorkspace } = await loadCore();
  const parsed = parseTypeScript(
    'nested.ts',
    readFileSync(join(root, 'fixtures/sample-src/nested.ts'), 'utf8'),
  );
  const names = parsed.symbols.map((s) => s.name);
  assert.ok(names.includes('NestedSvc'));
  assert.ok(names.includes('NestedSvc.login') || names.includes('login'));
  assert.ok(names.includes('topLevelFlag'));
  assert.ok(!names.some((n) => n === 'NestedSvc.ask' || n.endsWith('.ask')));

  const dir = fixtureDir();
  try {
    await indexWorkspace(dir);
    const hits = lookupSymbol(dir, 'NestedSvc');
    assert.ok(hits.some((h) => h.symbol === 'NestedSvc'));
    assert.ok(!hits.some((h) => h.symbol === 'NestedSvc.ask'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeIndexedPaths deletes file artifacts', async () => {
  const { indexWorkspace, removeIndexedPaths, openDatabase, resolveDbPath, getIndexStats } =
    await loadCore();
  const dir = fixtureDir();
  try {
    await indexWorkspace(dir);
    const before = getIndexStats(dir).files;
    assert.ok(before > 0);
    const n = removeIndexedPaths(dir, ['src/nested.ts']);
    assert.equal(n, 1);
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const row = db.prepare(`SELECT path FROM files WHERE path = ?`).get('src/nested.ts');
      assert.equal(row, undefined);
    } finally {
      db.close();
    }
    assert.ok(getIndexStats(dir).files < before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('index --git reindexes only changed files', async () => {
  const dir = fixtureDir();
  try {
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });

    const index1 = spawnSync(process.execPath, [cli, 'index', dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FASTPATH_EMBED: 'hash',
        FASTPATH_RERANK: 'off',
        FASTPATH_PARSER: 'legacy',
      },
    });
    assert.equal(index1.status, 0, index1.stderr);

    writeFileSync(join(dir, 'src/nested.ts'), 'export const onlyChanged = 1;\n');

    const gitIdx = spawnSync(process.execPath, [cli, 'index', dir, '--git'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FASTPATH_EMBED: 'hash',
        FASTPATH_RERANK: 'off',
        FASTPATH_PARSER: 'legacy',
      },
    });
    assert.equal(gitIdx.status, 0, gitIdx.stderr + gitIdx.stdout);
    assert.match(gitIdx.stdout, /mode=git/);
    assert.match(gitIdx.stdout, /indexed=1|indexed=[1-9]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor --json reports ready shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-doc-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export function a() { return b(); }\nfunction b(){return 1}\n');
    const env = {
      ...process.env,
      FASTPATH_EMBED: 'hash',
      FASTPATH_RERANK: 'off',
      FASTPATH_PARSER: 'legacy',
      FASTPATH_ALLOW_HASH: '1',
    };
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
    assert.ok(Array.isArray(json.issues));
    assert.ok(json.agentsIdeCompatible);
    assert.ok(json.hookEnabled);
    assert.ok(json.version);
    assert.ok(json.home);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pack-release stage would include CLI dist (dry structure check)', () => {
  assert.ok(existsSync(join(root, 'packages/cli/dist/index.js')));
  assert.ok(existsSync(join(root, 'scripts/pack-release.sh')));
  assert.ok(existsSync(join(root, 'scripts/install-home.sh')));
  assert.ok(existsSync(join(root, 'scripts/OFFICE_RUNBOOK.txt')));
  assert.ok(existsSync(join(root, 'scripts/SECURITY_NOTES.txt')));
  assert.ok(existsSync(join(root, 'scripts/INSTALL_PROMPT.txt')));
});
