import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('npm scripts only reference paths inside the repo', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(cmd, /\.\.\//, `script "${name}" escapes the repo: ${cmd}`);
  }
  for (const script of ['qc', 'eval:golden', 'bench']) {
    assert.ok(pkg.scripts[script], `missing npm script ${script}`);
  }
});

test('README does not claim Kiro-CLI agent generation', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /agents for AWS Kiro \(IDE and CLI\)/);
  assert.match(readme, /Kiro IDE/);
});

test('README advertises the collapsed 3-tool MCP surface', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /3 tools/);
  assert.doesNotMatch(readme, /7 tools/);
  assert.match(readme, /`find`/);
  assert.match(readme, /`impact`/);
  assert.match(readme, /`memory`/);
});

test('install-home refuses when source and home resolve to the same tree', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'fastpath-selfinstall-'));
  try {
    // Minimal FastPath-looking tree; the guard must fire before any copying.
    cpSync(join(root, 'package.json'), join(checkout, 'package.json'));
    cpSync(join(root, 'packages/cli/package.json'), join(checkout, 'packages/cli/package.json'), {
      recursive: true,
    });
    cpSync(
      join(root, 'packages/core/package.json'),
      join(checkout, 'packages/core/package.json'),
      { recursive: true },
    );

    const res = spawnSync('bash', [join(root, 'scripts/install-home.sh'), `${checkout}/.`], {
      encoding: 'utf8',
      env: { ...process.env, FASTPATH_HOME: checkout },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /same or nested paths/);
    // Nothing was deleted.
    assert.ok(existsSync(join(checkout, 'package.json')));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('fixtures are excluded from this repo own index', () => {
  const ignore = readFileSync(join(root, '.fastpathignore'), 'utf8');
  assert.match(ignore, /^fixtures\/$/m);
});
