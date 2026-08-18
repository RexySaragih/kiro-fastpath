/**
 * Control panel: job allowlist, loopback auth, SSE, viz JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const envBase = {
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

function httpCall(opts) {
  const { port, path, method = 'GET', headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, setHost: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('UI built assets exist', () => {
  assert.ok(
    existsSync(join(root, 'packages/ui/dist/index.html')),
    'packages/ui/dist/index.html missing — run npm run build:ui',
  );
});

test('job allowlist rejects unknown verb, unknown flag, relative path', async () => {
  const { validateJobRequest, JobValidationError } = await import(
    join(root, 'packages/cli/dist/ui-jobs.js')
  );
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-ui-allow-'));
  try {
    assert.throws(
      () => validateJobRequest({ verb: 'rm-rf' }),
      (err) => err instanceof JobValidationError && err.status === 400 && /unknown verb/.test(err.message),
    );
    assert.throws(
      () => validateJobRequest({ verb: 'index', workspace: dir, flags: ['--evil'] }),
      (err) => err instanceof JobValidationError && err.status === 400 && /unknown flag/.test(err.message),
    );
    assert.throws(
      () => validateJobRequest({ verb: 'index', workspace: 'relative/path' }),
      (err) => err instanceof JobValidationError && err.status === 400 && /absolute/.test(err.message),
    );
    const missing = join(dir, 'gone-workspace');
    const unwired = validateJobRequest({
      verb: 'unwire',
      workspace: missing,
      confirm: missing,
    });
    assert.equal(unwired.spec.verb, 'unwire');
    assert.ok(unwired.spec.workspace?.endsWith('gone-workspace'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UI server: 401, 403 rebinding, 409 confirm, traversal, viz JSON, SSE exit', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-ui-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-ui-ws-'));
  const uiRoot = mkdtempSync(join(tmpdir(), 'fastpath-ui-static-'));
  const prevUser = process.env.FASTPATH_USER_DIR;
  process.env.FASTPATH_USER_DIR = userDir;
  for (const [k, v] of Object.entries(envBase)) process.env[k] = v;

  cpSync(join(root, 'fixtures/sample-src'), join(ws, 'src'), { recursive: true });
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>fp</title>');

  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  await indexWorkspace(ws);

  const { startUiServer } = await import(join(root, 'packages/cli/dist/ui-server.js'));
  const { buildVizPageData } = await import(join(root, 'packages/cli/dist/viz.js'));
  const { resetJobsForTests } = await import(join(root, 'packages/cli/dist/ui-jobs.js'));

  const token = 't'.repeat(64);
  const handle = await startUiServer({
    workspace: ws,
    port: 0,
    token,
    uiRoot,
    openBrowser: false,
  });

  try {
    const auth = { Authorization: `Bearer ${token}` };
    const loopbackHost = `127.0.0.1:${handle.port}`;

    const noTok = await httpCall({
      port: handle.port,
      path: '/api/state',
      headers: { Host: loopbackHost },
    });
    assert.equal(noTok.status, 401);

    const badHost = await httpCall({
      port: handle.port,
      path: '/api/state',
      headers: { Host: 'evil.example:80', Authorization: `Bearer ${token}` },
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await httpCall({
      port: handle.port,
      path: '/api/state',
      headers: {
        Host: loopbackHost,
        Origin: 'http://evil.example',
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(badOrigin.status, 403);

    const unconfirmed = await httpCall({
      port: handle.port,
      path: '/api/jobs',
      method: 'POST',
      headers: {
        Host: loopbackHost,
        'Content-Type': 'application/json',
        ...auth,
      },
      body: JSON.stringify({ verb: 'upgrade' }),
    });
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.body, /confirm/);

    const trav = await httpCall({
      port: handle.port,
      path: '/a/%2e%2e%2f%2e%2e%2fetc/passwd',
      headers: { Host: loopbackHost },
    });
    assert.equal(trav.status, 403);

    const vizRes = await httpCall({
      port: handle.port,
      path: `/api/viz?workspace=${encodeURIComponent(ws)}`,
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(vizRes.status, 200);
    const expected = buildVizPageData(ws);
    const got = JSON.parse(vizRes.body);
    assert.equal(got.workspace, expected.workspace);
    assert.equal(got.summary.files, expected.summary.files);
    assert.equal(got.summary.symbols, expected.summary.symbols);
    assert.deepEqual(got.projectMetrics, expected.projectMetrics);
    assert.deepEqual(got.globalMetrics, expected.globalMetrics);
    assert.deepEqual(got.eventMix, expected.eventMix);

    const posted = await httpCall({
      port: handle.port,
      path: '/api/jobs',
      method: 'POST',
      headers: {
        Host: loopbackHost,
        'Content-Type': 'application/json',
        ...auth,
      },
      body: JSON.stringify({ verb: 'doctor', workspace: ws }),
    });
    assert.equal(posted.status, 201);
    const { jobId } = JSON.parse(posted.body);
    assert.ok(jobId);

    const exit = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: handle.port,
          path: `/api/jobs/${jobId}/stream`,
          method: 'GET',
          headers: { Host: loopbackHost, ...auth },
          setHost: false,
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString('utf8');
            const blocks = buf.split('\n\n');
            for (const block of blocks) {
              const line = block.split('\n').find((l) => l.startsWith('data: '));
              if (!line) continue;
              const payload = JSON.parse(line.slice(6));
              if ('exit' in payload) {
                resolve(payload.exit);
                req.destroy();
                return;
              }
            }
          });
          res.on('end', () => reject(new Error('stream ended without exit')));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(typeof exit, 'number');
  } finally {
    resetJobsForTests();
    await handle.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
    if (prevUser === undefined) delete process.env.FASTPATH_USER_DIR;
    else process.env.FASTPATH_USER_DIR = prevUser;
  }
});

test('UI server listens on loopback only', async () => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'fastpath-ui-lb-'));
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>fp</title>');
  const { startUiServer } = await import(join(root, 'packages/cli/dist/ui-server.js'));
  const handle = await startUiServer({
    workspace: root,
    port: 0,
    token: 'x'.repeat(64),
    uiRoot,
    openBrowser: false,
  });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    assert.doesNotMatch(handle.url, /0\.0\.0\.0/);
  } finally {
    await handle.close();
    rmSync(uiRoot, { recursive: true, force: true });
  }
});
