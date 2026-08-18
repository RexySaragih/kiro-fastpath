/**
 * Loopback HTTP server for `fastpath ui`.
 * Bearer session token + Host/Origin rebinding guard. No express.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  statSync,
} from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { getIndexStats, minilmWeightsPresent, modelCacheDir } from '@fastpath/core';
import {
  defaultFastpathHome,
  listWiredWorkspaces,
  loadConfig,
  PACKAGE_ROOT,
  readPackageVersion,
  resolveFastpathHome,
} from './config.js';
import { runDoctor } from './doctor.js';
import { isEphemeralWorkspace } from './viz-scope.js';
import {
  getJob,
  JobValidationError,
  killJob,
  startJob,
  type JobLine,
} from './ui-jobs.js';
import { pickFolder } from './ui-pick-folder.js';
import { buildVizPageData } from './viz.js';

const DEFAULT_PORT = 8787;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function uiDistPath(): string {
  return join(PACKAGE_ROOT, 'packages/ui/dist');
}

export function assertUiAssets(root = uiDistPath()): void {
  if (!existsSync(join(root, 'index.html'))) {
    console.error('UI assets missing — run npm run build:ui');
    process.exit(2);
  }
}

export interface UiServerOptions {
  workspace: string;
  port?: number;
  token?: string;
  uiRoot?: string;
  openBrowser?: boolean;
}

export interface UiServerHandle {
  token: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function tokenFromRequest(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const q = url.searchParams.get('t');
  return q && q.length > 0 ? q : null;
}

function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, '');
  const resolved = resolve(root, rel);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) return null;
  return resolved;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

interface RepoStatsEntry {
  files: number;
  symbols: number;
  indexedAt: string | null;
}

function collectRepoStats(wired: string[]): Record<string, RepoStatsEntry> {
  const stats: Record<string, RepoStatsEntry> = {};
  for (const workspace of wired) {
    if (isEphemeralWorkspace(workspace) || !existsSync(workspace)) continue;
    try {
      const s = getIndexStats(workspace);
      stats[workspace] = { files: s.files, symbols: s.symbols, indexedAt: s.indexedAt };
    } catch {
      /* one broken index must not break /api/state */
    }
  }
  return stats;
}

function workspaceFrom(url: URL, fallback: string): string {
  const q = url.searchParams.get('workspace');
  return q && q.length > 0 ? q : fallback;
}

function writeSse(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  defaultWorkspace: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/api/state') {
    const home = resolveFastpathHome();
    const wired = listWiredWorkspaces();
    send(res, 200, {
      version: readPackageVersion(home),
      home,
      defaultHome: defaultFastpathHome(),
      checkout: PACKAGE_ROOT,
      installed: existsSync(join(home, 'packages/cli/dist/index.js')),
      cli: join(home, 'packages/cli/dist/index.js'),
      wired,
      config: loadConfig(),
      modelsReady: minilmWeightsPresent(),
      modelCache: modelCacheDir(),
      repoStats: collectRepoStats(wired),
    });
    return;
  }

  if (method === 'GET' && path === '/api/doctor') {
    const workspace = workspaceFrom(url, defaultWorkspace);
    const result = await runDoctor(workspace);
    send(res, 200, result);
    return;
  }

  if (method === 'GET' && path === '/api/viz') {
    const workspace = workspaceFrom(url, defaultWorkspace);
    try {
      send(res, 200, buildVizPageData(workspace));
    } catch (err) {
      send(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (method === 'GET' && path === '/api/status') {
    const workspace = workspaceFrom(url, defaultWorkspace);
    send(res, 200, getIndexStats(workspace));
    return;
  }

  if (method === 'POST' && path === '/api/pick-folder') {
    try {
      await readJson(req);
    } catch {
      /* empty or invalid body is fine */
    }
    const picked = pickFolder();
    if (picked.cancelled) {
      send(res, 200, { path: null, cancelled: true });
      return;
    }
    if (picked.error || !picked.path) {
      send(res, 500, { error: picked.error ?? 'folder picker failed' });
      return;
    }
    send(res, 200, { path: picked.path, cancelled: false });
    return;
  }

  if (method === 'POST' && path === '/api/jobs') {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      send(res, 400, { error: 'invalid json' });
      return;
    }
    try {
      const { id } = startJob(body);
      send(res, 201, { jobId: id });
    } catch (err) {
      if (err instanceof JobValidationError) {
        send(res, err.status, {
          error: err.message,
          ...(err.confirmTarget ? { confirmTarget: err.confirmTarget } : {}),
        });
        return;
      }
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const streamMatch = path.match(/^\/api\/jobs\/([^/]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const job = getJob(streamMatch[1] as string);
    if (!job) {
      send(res, 404, { error: 'job not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const line of job.lines) writeSse(res, line);
    if (job.ended) {
      writeSse(res, { exit: job.exitCode });
      res.end();
      return;
    }
    const onLine = (line: JobLine) => writeSse(res, line);
    const onExit = (code: number | null) => {
      writeSse(res, { exit: code });
      res.end();
    };
    job.listeners.add(onLine);
    job.exitListeners.add(onExit);
    req.on('close', () => {
      job.listeners.delete(onLine);
      job.exitListeners.delete(onExit);
    });
    return;
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'DELETE' && jobMatch) {
    const ok = killJob(jobMatch[1] as string);
    send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'job not found' });
    return;
  }

  send(res, 404, { error: 'not found' });
}

function serveStatic(res: ServerResponse, filePath: string): void {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=31536000',
  });
  createReadStream(filePath).pipe(res);
}

export function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const uiRoot = resolve(opts.uiRoot ?? uiDistPath());
  const token = opts.token ?? randomBytes(32).toString('hex');
  const portWanted = opts.port ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    const hostHeader = req.headers.host;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : portWanted;
    if (!hostAllowed(hostHeader, port) || !originAllowed(req.headers.origin, port)) {
      send(res, 403, { error: 'forbidden host' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const presented = tokenFromRequest(req, url);
      if (presented !== token) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      void handleApi(req, res, url, opts.workspace).catch((err) => {
        if (!res.headersSent) {
          send(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    if ((req.method ?? 'GET') !== 'GET') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const safe = safeJoin(uiRoot, requested);
    if (!safe) {
      send(res, 403, { error: 'forbidden path' });
      return;
    }
    if (existsSync(safe) && statSync(safe).isFile()) {
      serveStatic(res, safe);
      return;
    }
    const index = join(uiRoot, 'index.html');
    if (existsSync(index)) {
      serveStatic(res, index);
      return;
    }
    send(res, 404, 'not found');
  });

  return new Promise((resolveHandle, reject) => {
    server.once('error', reject);
    server.listen(portWanted, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : portWanted;
      const url = `http://127.0.0.1:${port}/?t=${token}`;
      resolveHandle({
        token,
        port,
        url,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

export async function startUiCommand(opts: {
  workspace: string;
  port?: number;
  openBrowser: boolean;
}): Promise<void> {
  const { openInBrowser } = await import('./viz.js');
  assertUiAssets();
  const handle = await startUiServer({
    workspace: opts.workspace,
    port: opts.port,
    openBrowser: opts.openBrowser,
  });
  console.log(`FastPath UI → ${handle.url}`);
  if (opts.openBrowser) openInBrowser(handle.url);
  await new Promise<void>((resolveWait) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        process.exit(0);
        return;
      }
      stopping = true;
      void handle.close().then(
        () => resolveWait(),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
