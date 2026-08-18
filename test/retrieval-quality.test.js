import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function core() {
  return import(join(root, 'packages/core/dist/index.js'));
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-quality-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src/session.ts'),
    [
      '/** Rejects a session once its expiry timestamp has passed. */',
      'export function checkStale(session: Session): boolean {',
      '  const now = Date.now();',
      '  return session.expiresAt < now;',
      '}',
      '',
      'export function refresh(session: Session): Session {',
      '  return { ...session, expiresAt: Date.now() + 900_000 };',
      '}',
    ].join('\n'),
  );
  return dir;
}

test('chunks persist AST spans with a natural-language header', async () => {
  const { indexWorkspace, openDatabase, resolveDbPath } = await core();
  const dir = makeWorkspace();
  try {
    await indexWorkspace(dir);
    const db = openDatabase(resolveDbPath(dir), { create: false });
    try {
      const row = db
        .prepare(`SELECT * FROM chunks WHERE header LIKE '%checkStale%' LIMIT 1`)
        .get();
      assert.ok(row, 'no chunk stored for checkStale');
      assert.match(row.header, /^src\/session\.ts > checkStale/);
      assert.ok(row.start_line >= 1);
      assert.ok(row.end_line >= row.start_line);
      // Body text and leading doc comment are searchable, not just the name.
      assert.match(row.text, /expiry timestamp/);
      assert.match(row.text, /session\.expiresAt < now/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('body-level matches carry a line anchor (no line: null file hits)', async () => {
  const { indexWorkspace, searchIndex } = await core();
  const dir = makeWorkspace();
  try {
    await indexWorkspace(dir);
    const hits = await searchIndex(dir, 'expiry timestamp has passed', { topK: 5 });
    assert.ok(hits.length > 0);
    const bodyHits = hits.filter((h) => h.path === 'src/session.ts');
    assert.ok(bodyHits.length > 0, 'expected a hit in session.ts');
    for (const hit of bodyHits) {
      assert.ok(hit.line, `hit without line anchor: ${JSON.stringify(hit)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query terms are tokenized and synonym-expanded', async () => {
  const { expandQueryTerms, extractQuerySignals } = await import(
    join(root, 'packages/core/dist/search/query.js')
  );
  const terms = expandQueryTerms('validateJwt');
  assert.ok(terms.includes('validate'), terms.join(','));
  assert.ok(terms.includes('jwt'), terms.join(','));
  assert.ok(expandQueryTerms('login flow').includes('auth'));
  assert.ok(expandQueryTerms('middleware layer').includes('interceptor'));
  assert.ok(expandQueryTerms('deploy pipeline').includes('release'));

  const signals = extractQuerySignals(
    'please fix `AuthService` in src/auth.ts and check validateJwt',
  );
  assert.ok(signals.includes('AuthService'), signals.join(','));
  assert.ok(signals.includes('src/auth.ts'), signals.join(','));
  assert.ok(signals.includes('validateJwt'), signals.join(','));
  assert.deepEqual(extractQuerySignals('how does this work in general'), []);
});

test('context pack merges per file and respects a token budget', async () => {
  const { indexWorkspace, contextForTask } = await core();
  const { CONTEXT_TOKEN_BUDGET } = await import(
    join(root, 'packages/core/dist/search/query.js')
  );
  const dir = makeWorkspace();
  try {
    await indexWorkspace(dir);
    const hits = await contextForTask(dir, 'session expiry refresh', 8);
    const codeHits = hits.filter((h) => h.kind !== 'imports');
    const paths = codeHits.map((h) => h.path);
    assert.equal(new Set(paths).size, paths.length, 'duplicate file hunks emitted');

    const tokens = Math.ceil(
      codeHits.reduce((n, h) => n + `${h.path}${h.symbol ?? ''}${h.snippet ?? ''}`.length, 0) / 4,
    );
    // First hunk may exceed the budget on its own; subsequent fills must not.
    assert.ok(
      codeHits.length === 1 || tokens <= CONTEXT_TOKEN_BUDGET * 2,
      `context pack too large: ${tokens} tokens`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zero-hit ladder recovers via identifiers before giving up', async () => {
  const { indexWorkspace } = await core();
  const { zeroHitLadder } = await import(join(root, 'packages/core/dist/search/query.js'));
  const dir = makeWorkspace();
  try {
    await indexWorkspace(dir);
    const hits = zeroHitLadder(dir, 'please look at checkStale in src/session.ts', 5);
    assert.ok(hits.length > 0, 'ladder returned nothing');
    assert.ok(hits.some((h) => h.path === 'src/session.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
