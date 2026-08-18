import type { ActiveJob, DoctorResult, IndexStats, JobSpec, StatePayload, VizPageData } from './types';

const TOKEN_KEY = 'fastpath.ui.token';

let token = '';

export function captureToken(): string {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('t');
  if (t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    const url = new URL(window.location.href);
    url.searchParams.delete('t');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    token = t;
    return t;
  }
  token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly confirmTarget?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    let confirmTarget: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; confirmTarget?: string };
      message = parsed.error ?? text;
      confirmTarget = parsed.confirmTarget;
    } catch {
      /* raw */
    }
    throw new ApiError(res.status, message, confirmTarget);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export function fetchState(): Promise<StatePayload> {
  return api('/api/state');
}

export function fetchDoctor(workspace: string): Promise<DoctorResult> {
  return api(`/api/doctor?workspace=${encodeURIComponent(workspace)}`);
}

export function fetchViz(workspace: string): Promise<VizPageData> {
  return api(`/api/viz?workspace=${encodeURIComponent(workspace)}`);
}

export function fetchStatus(workspace: string): Promise<IndexStats> {
  return api(`/api/status?workspace=${encodeURIComponent(workspace)}`);
}

export async function postJob(spec: JobSpec): Promise<{ jobId: string }> {
  return api('/api/jobs', { method: 'POST', body: JSON.stringify(spec) });
}

export function killJob(id: string): Promise<{ ok: boolean }> {
  return api(`/api/jobs/${id}`, { method: 'DELETE' });
}

export async function pickFolder(): Promise<string | null> {
  const result = await api<{ path: string | null; cancelled?: boolean }>('/api/pick-folder', {
    method: 'POST',
    body: '{}',
  });
  return result.path;
}

export async function streamJob(
  jobId: string,
  onLine: (line: { stream: 'stdout' | 'stderr'; line: string }) => void,
  onExit: (code: number | null) => void,
): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, 'stream failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const dataLine = part
        .split('\n')
        .find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(6)) as {
        stream?: 'stdout' | 'stderr';
        line?: string;
        exit?: number | null;
      };
      if ('exit' in payload) {
        onExit(payload.exit ?? null);
        return;
      }
      if (payload.stream && payload.line != null) {
        onLine({ stream: payload.stream, line: payload.line });
      }
    }
  }
}

export function patchJob(
  jobs: ActiveJob[],
  id: string,
  patch: Partial<ActiveJob>,
): ActiveJob[] {
  return jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
}
