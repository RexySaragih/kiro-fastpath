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

    const pickNoTok = await httpCall({
      port: handle.port,
      path: '/api/pick-folder',
      method: 'POST',
      headers: { Host: loopbackHost, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(pickNoTok.status, 401);

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

    const stateRes = await httpCall({
      port: handle.port,
      path: '/api/state',
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(stateRes.status, 200);
    const state = JSON.parse(stateRes.body);
    assert.equal(typeof state.modelsReady, 'boolean');
    assert.equal(typeof state.modelCache, 'string');
    assert.ok(state.repoStats && typeof state.repoStats === 'object');
    for (const entry of Object.values(state.repoStats)) {
      assert.equal(typeof entry.files, 'number');
      assert.equal(typeof entry.symbols, 'number');
    }

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

test('UI server close does not hang on keep-alive', async () => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'fastpath-ui-close-'));
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
    await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: handle.port,
          path: '/',
          headers: { Host: `127.0.0.1:${handle.port}` },
          setHost: false,
        },
        (res) => {
          res.resume();
          resolve(undefined);
        },
      );
      req.on('error', reject);
      req.end();
    });
    const started = Date.now();
    await handle.close();
    assert.ok(Date.now() - started < 2000, 'close hung on open connection');
  } finally {
    rmSync(uiRoot, { recursive: true, force: true });
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

test('modes API get/put/validate', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-ui-modes-user-'));
  const ws = mkdtempSync(join(tmpdir(), 'fastpath-ui-modes-ws-'));
  const uiRoot = mkdtempSync(join(tmpdir(), 'fastpath-ui-modes-static-'));
  const prevUser = process.env.FASTPATH_USER_DIR;
  process.env.FASTPATH_USER_DIR = userDir;
  for (const [k, v] of Object.entries(envBase)) process.env[k] = v;
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>fp</title>');

  const { startUiServer } = await import(join(root, 'packages/cli/dist/ui-server.js'));
  const token = 'm'.repeat(64);
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
    const qs = `workspace=${encodeURIComponent(ws)}`;

    const noTok = await httpCall({
      port: handle.port,
      path: `/api/modes?${qs}`,
      headers: { Host: loopbackHost },
    });
    assert.equal(noTok.status, 401);

    const get1 = await httpCall({
      port: handle.port,
      path: `/api/modes?${qs}`,
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(get1.status, 200);
    const g1 = JSON.parse(get1.body);
    assert.deepEqual(g1.levels, ['off', 'lite', 'full', 'ultra']);
    assert.equal(g1.effective.caveman, 'full');
    assert.equal(g1.effective.ponytail, 'full');
    assert.equal(g1.wired, false);

    const putWs = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, caveman: 'lite' }),
    });
    assert.equal(putWs.status, 200, putWs.body);
    const p1 = JSON.parse(putWs.body);
    assert.equal(p1.effective.caveman, 'lite');
    assert.equal(p1.workspace.caveman, 'lite');

    const get2 = await httpCall({
      port: handle.port,
      path: `/api/modes?${qs}`,
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(JSON.parse(get2.body).effective.caveman, 'lite');

    const badLevel = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, caveman: 'loud' }),
    });
    assert.equal(badLevel.status, 400);
    assert.match(badLevel.body, /unknown level/);

    const badKey = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, loudness: 'lite' }),
    });
    assert.equal(badKey.status, 400);
    assert.match(badKey.body, /unknown key/);

    const rel = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: 'relative/path', caveman: 'lite' }),
    });
    assert.equal(rel.status, 400);

    const inheritGlobal = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ caveman: 'inherit' }),
    });
    assert.equal(inheritGlobal.status, 400);
    assert.match(inheritGlobal.body, /inherit not allowed at global scope/);

    const putGlobal = await httpCall({
      port: handle.port,
      path: '/api/modes',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ caveman: 'ultra' }),
    });
    assert.equal(putGlobal.status, 200, putGlobal.body);
    const pg = JSON.parse(putGlobal.body);
    assert.equal(pg.global.caveman, 'ultra');
    assert.equal(pg.wired, false);
    assert.deepEqual(pg.workspace, {});

    assert.equal(existsSync(join(ws, '.kiro')), false);

    const getPrefs = await httpCall({
      port: handle.port,
      path: `/api/prefs?${qs}`,
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(getPrefs.status, 200, getPrefs.body);
    const prefs0 = JSON.parse(getPrefs.body);
    assert.equal(prefs0.effective.inject.maxHits, 4);
    assert.equal(prefs0.effective.effortReminders.scout, 'low');

    const putPrefs = await httpCall({
      port: handle.port,
      path: '/api/prefs',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspace: ws,
        inject: { maxHits: 6 },
        effortReminders: { scout: 'high' },
      }),
    });
    assert.equal(putPrefs.status, 200, putPrefs.body);
    const prefs1 = JSON.parse(putPrefs.body);
    assert.equal(prefs1.effective.inject.maxHits, 6);
    assert.equal(prefs1.effective.effortReminders.scout, 'high');

    const getMem = await httpCall({
      port: handle.port,
      path: `/api/memory?${qs}`,
      headers: { Host: loopbackHost, ...auth },
    });
    assert.equal(getMem.status, 200, getMem.body);
    const mem0 = JSON.parse(getMem.body);
    assert.equal(mem0.effective.sessionMax, 50);
    assert.equal(mem0.effective.capture, true);

    const putMem = await httpCall({
      port: handle.port,
      path: '/api/memory',
      method: 'PUT',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, sessionMax: 12, capture: false }),
    });
    assert.equal(putMem.status, 200, putMem.body);
    const mem1 = JSON.parse(putMem.body);
    assert.equal(mem1.effective.sessionMax, 12);
    assert.equal(mem1.effective.capture, false);

    const wipeNo = await httpCall({
      port: handle.port,
      path: '/api/memory/wipe',
      method: 'POST',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, kind: 'session' }),
    });
    assert.equal(wipeNo.status, 400);
    assert.match(wipeNo.body, /yes must be true/);

    const wipeOk = await httpCall({
      port: handle.port,
      path: '/api/memory/wipe',
      method: 'POST',
      headers: {
        Host: loopbackHost,
        ...auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspace: ws, kind: 'session', yes: true }),
    });
    assert.equal(wipeOk.status, 200, wipeOk.body);
    assert.equal(JSON.parse(wipeOk.body).wiped, 0);
  } finally {
    await handle.close();
    if (prevUser === undefined) delete process.env.FASTPATH_USER_DIR;
    else process.env.FASTPATH_USER_DIR = prevUser;
    rmSync(userDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
  }
});
