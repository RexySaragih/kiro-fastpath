/**
 * Strict job allowlist + child-process registry for `fastpath ui`.
 * No shell. Flags are enums. Paths must be absolute and exist.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultFastpathHome, PACKAGE_ROOT, resolveFastpathHome } from './config.js';

export const JOB_VERBS = [
  'index',
  'watch',
  'warm',
  'doctor',
  'use',
  'install-kiro',
  'repair-kiro',
  'rewire',
  'unwire',
  'upgrade',
  'repair-native',
  'memory-distill',
  'install-home',
] as const;

export type JobVerb = (typeof JOB_VERBS)[number];

export const ALLOWED_FLAGS: Record<JobVerb, ReadonlySet<string>> = {
  index: new Set(['--git', '--rebuild']),
  watch: new Set(),
  warm: new Set(),
  doctor: new Set(),
  use: new Set(),
  'install-kiro': new Set(),
  'repair-kiro': new Set(),
  rewire: new Set(['--all']),
  unwire: new Set(['--purge-index']),
  upgrade: new Set(['--rewire']),
  'repair-native': new Set(),
  'memory-distill': new Set(),
  'install-home': new Set(),
};

export const DESTRUCTIVE_VERBS: ReadonlySet<JobVerb> = new Set([
  'install-home',
  'upgrade',
  'unwire',
  'repair-native',
]);

const WORKSPACE_REQUIRED: ReadonlySet<JobVerb> = new Set([
  'index',
  'watch',
  'doctor',
  'use',
  'install-kiro',
  'repair-kiro',
  'unwire',
  'memory-distill',
]);

const RING_CAP = 500;
const CLI_BIN = join(PACKAGE_ROOT, 'packages/cli/dist/index.js');
const INSTALL_HOME_SH = join(PACKAGE_ROOT, 'scripts/install-home.sh');

export interface JobSpec {
  verb: JobVerb;
  workspace?: string;
  flags?: string[];
  from?: string;
}

export interface JobRequest extends JobSpec {
  confirm?: string;
}

export interface JobLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export class JobValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly confirmTarget?: string,
  ) {
    super(message);
    this.name = 'JobValidationError';
  }
}

export interface ValidatedJob {
  spec: JobSpec;
  argv: string[];
  command: string;
  env: NodeJS.ProcessEnv;
}

type LineListener = (line: JobLine) => void;
type ExitListener = (code: number | null) => void;

export interface JobRecord {
  id: string;
  spec: JobSpec;
  startedAt: string;
  child: ChildProcess | null;
  lines: JobLine[];
  exitCode: number | null;
  ended: boolean;
  listeners: Set<LineListener>;
  exitListeners: Set<ExitListener>;
}

const jobs = new Map<string, JobRecord>();

export function isJobVerb(value: unknown): value is JobVerb {
  return typeof value === 'string' && (JOB_VERBS as readonly string[]).includes(value);
}

export function isDestructive(spec: JobSpec): boolean {
  if (DESTRUCTIVE_VERBS.has(spec.verb)) return true;
  return spec.verb === 'index' && Boolean(spec.flags?.includes('--rebuild'));
}

export function needsWorkspace(spec: Pick<JobSpec, 'verb' | 'flags'>): boolean {
  if (spec.verb === 'rewire') return !spec.flags?.includes('--all');
  return WORKSPACE_REQUIRED.has(spec.verb);
}

function requireExistingAbs(label: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new JobValidationError(`${label} must be an absolute path`, 400);
  }
  if (!existsSync(value)) {
    throw new JobValidationError(`${label} does not exist: ${value}`, 400);
  }
  return realpathSync(value);
}

function resolveMaybeMissingAbs(value: string): string {
  if (!isAbsolute(value)) {
    throw new JobValidationError('path must be an absolute path', 400);
  }
  return existsSync(value) ? realpathSync(value) : resolve(value);
}

export function destructiveConfirmTarget(spec: JobSpec): string {
  switch (spec.verb) {
    case 'install-home':
      return resolveMaybeMissingAbs(defaultFastpathHome());
    case 'upgrade':
    case 'repair-native':
      return resolveMaybeMissingAbs(resolveFastpathHome());
    case 'unwire':
    case 'index':
      if (!spec.workspace) return '';
      return existsSync(spec.workspace)
        ? realpathSync(spec.workspace)
        : resolve(spec.workspace);
    default:
      return '';
  }
}

export function validateJobRequest(body: unknown): ValidatedJob {
  if (!body || typeof body !== 'object') {
    throw new JobValidationError('job body must be an object', 400);
  }
  const raw = body as Record<string, unknown>;
  if (!isJobVerb(raw.verb)) {
    throw new JobValidationError('unknown verb', 400);
  }
  const verb = raw.verb;
  const allowed = ALLOWED_FLAGS[verb];
  const flags = Array.isArray(raw.flags)
    ? raw.flags.filter((f): f is string => typeof f === 'string')
    : [];
  for (const flag of flags) {
    if (!allowed.has(flag)) {
      throw new JobValidationError(`unknown flag: ${flag}`, 400);
    }
  }

  const spec: JobSpec = { verb, flags };
  if (typeof raw.workspace === 'string' && raw.workspace.length > 0) {
    spec.workspace =
      verb === 'unwire'
        ? resolveMaybeMissingAbs(raw.workspace)
        : requireExistingAbs('workspace', raw.workspace);
  }
  if (typeof raw.from === 'string' && raw.from.length > 0) {
    spec.from = requireExistingAbs('from', raw.from);
  }

  if (needsWorkspace(spec) && !spec.workspace) {
    throw new JobValidationError('workspace is required', 400);
  }
  if (verb === 'install-home' && !spec.from) {
    throw new JobValidationError('from (checkout or zip) is required', 400);
  }

  if (isDestructive(spec)) {
    const target = destructiveConfirmTarget(spec);
    const confirm = typeof raw.confirm === 'string' ? raw.confirm : '';
    const confirmResolved = confirm
      ? resolveMaybeMissingAbs(confirm)
      : '';
    if (!confirm || confirmResolved !== target) {
      throw new JobValidationError('confirm required', 409, target);
    }
  }

  return buildSpawn(spec);
}

function buildSpawn(spec: JobSpec): ValidatedJob {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (spec.workspace) env.FASTPATH_WORKSPACE = spec.workspace;

  if (spec.verb === 'install-home') {
    env.FASTPATH_HOME = defaultFastpathHome();
    const argv = [INSTALL_HOME_SH, spec.from as string];
    return { spec, command: 'bash', argv, env };
  }

  const argv: string[] = [];
  if (spec.verb === 'memory-distill') {
    argv.push('memory', 'distill');
  } else {
    argv.push(spec.verb);
  }
  if (spec.verb === 'upgrade' && spec.from) {
    argv.push('--from', spec.from);
  }
  for (const flag of spec.flags ?? []) argv.push(flag);
  if (spec.workspace && spec.verb !== 'upgrade' && spec.verb !== 'warm' && spec.verb !== 'repair-native') {
    argv.push(spec.workspace);
  }

  return { spec, command: process.execPath, argv: [CLI_BIN, ...argv], env };
}

function pushLine(job: JobRecord, line: JobLine): void {
  job.lines.push(line);
  if (job.lines.length > RING_CAP) job.lines.splice(0, job.lines.length - RING_CAP);
  for (const listener of job.listeners) listener(line);
}

function attachPipes(job: JobRecord, child: ChildProcess): void {
  const leftover: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const bind = (stream: 'stdout' | 'stderr') => {
    const pipe = child[stream];
    if (!pipe) return;
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk: string) => {
      leftover[stream] += chunk;
      const parts = leftover[stream].split('\n');
      leftover[stream] = parts.pop() ?? '';
      for (const part of parts) pushLine(job, { stream, line: part });
    });
  };
  bind('stdout');
  bind('stderr');
  child.on('close', (code) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (leftover[stream]) pushLine(job, { stream, line: leftover[stream] });
    }
    job.ended = true;
    job.exitCode = code;
    for (const listener of job.exitListeners) listener(code);
    job.listeners.clear();
    job.exitListeners.clear();
  });
  child.on('error', (err) => {
    pushLine(job, { stream: 'stderr', line: err.message });
    job.ended = true;
    job.exitCode = 127;
    for (const listener of job.exitListeners) listener(127);
    job.listeners.clear();
    job.exitListeners.clear();
  });
}

export function startJob(body: unknown): { id: string } {
  const validated = validateJobRequest(body);
  const id = randomBytes(8).toString('hex');
  const job: JobRecord = {
    id,
    spec: validated.spec,
    startedAt: new Date().toISOString(),
    child: null,
    lines: [],
    exitCode: null,
    ended: false,
    listeners: new Set(),
    exitListeners: new Set(),
  };
  jobs.set(id, job);

  const child = spawn(validated.command, validated.argv, {
    env: validated.env,
    cwd: PACKAGE_ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  attachPipes(job, child);
  return { id };
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function killJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.ended || !job.child) return false;
  const child = job.child;
  child.kill('SIGTERM');
  const killer = setTimeout(() => {
    if (!job.ended) child.kill('SIGKILL');
  }, 2000);
  killer.unref();
  return true;
}

/** Test helper — drop in-memory jobs between cases. */
export function resetJobsForTests(): void {
  for (const job of jobs.values()) {
    if (!job.ended && job.child) job.child.kill('SIGKILL');
  }
  jobs.clear();
}
