import { useCallback, useEffect, useState } from 'react';
import { fetchMemory, putMemory, wipeMemory } from '../api';
import type { JobResult, JobSpec, MemoryPayload } from '../types';
import { EmptyState, InlineError, Panel, PanelLabel } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { ScreenSkeleton } from '../components/Skeleton';
import { isEphemeralWorkspace } from '../workspace';

type MemDraft = MemoryPayload['effective'];

const NUMBER_FIELDS: Array<{
  key: keyof MemDraft;
  label: string;
  min: number;
  max: number;
  step?: number;
}> = [
  { key: 'sessionMax', label: 'Session max', min: 5, max: 200 },
  { key: 'pruneAfterDays', label: 'Prune after (days)', min: 7, max: 365 },
  { key: 'pruneScoreFloor', label: 'Prune score floor', min: 0, max: 1, step: 0.01 },
  { key: 'recencyHalfLifeDays', label: 'Recency half-life (days)', min: 1, max: 180 },
  { key: 'recallTopK', label: 'Recall top-K', min: 1, max: 10 },
  { key: 'sessionInjectCount', label: 'Session inject count', min: 1, max: 20 },
  { key: 'sessionInjectChars', label: 'Session inject chars', min: 40, max: 500 },
];

export function MemoryScreen({
  workspace,
  onRun,
  onOpenRepos,
}: {
  workspace: string;
  onRun: (spec: JobSpec) => Promise<JobResult>;
  onOpenRepos?: () => void;
}) {
  const durable = Boolean(workspace) && !isEphemeralWorkspace(workspace);
  const [data, setData] = useState<MemoryPayload | null>(null);
  const [draft, setDraft] = useState<MemDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wipeKind, setWipeKind] = useState<'session' | 'all'>('session');
  const [olderDays, setOlderDays] = useState('');

  const reload = useCallback(() => {
    if (!durable) {
      setLoading(false);
      setData(null);
      return Promise.resolve();
    }
    setLoading(true);
    return fetchMemory(workspace)
      .then((payload) => {
        setData(payload);
        setDraft({ ...payload.effective });
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [durable, workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!durable) {
    return (
      <EmptyState
        title="No durable workspace"
        body="Connect a real project in Repos first."
        action={
          onOpenRepos ? (
            <MagneticButton onClick={onOpenRepos}>Open Repos</MagneticButton>
          ) : undefined
        }
      />
    );
  }

  if (loading) return <ScreenSkeleton />;
  if (error || !data || !draft) {
    return (
      <EmptyState
        title="Memory could not load"
        body={error ?? 'No payload'}
        action={<MagneticButton onClick={() => void reload()}>Retry</MagneticButton>}
      />
    );
  }

  const dirty = NUMBER_FIELDS.some((f) => draft[f.key] !== data.effective[f.key]) ||
    draft.autoPrune !== data.effective.autoPrune ||
    draft.capture !== data.effective.capture;

  async function save() {
    if (!draft || !data) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const body: Record<string, unknown> = { workspace };
      for (const f of NUMBER_FIELDS) {
        if (draft[f.key] !== data.effective[f.key]) body[f.key] = draft[f.key];
      }
      if (draft.autoPrune !== data.effective.autoPrune) body.autoPrune = draft.autoPrune;
      if (draft.capture !== data.effective.capture) body.capture = draft.capture;
      await putMemory(body);
      if (data.wired && draft.capture !== data.effective.capture) {
        const result = await onRun({ verb: 'rewire', workspace });
        if (result.code !== 0) {
          setErr(result.tail ?? `rewire failed (exit ${result.code})`);
          return;
        }
      }
      setMsg('Saved');
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doWipe() {
    if (!window.confirm(`Wipe ${wipeKind} memories in this workspace? Pinned stay.`)) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const older = olderDays.trim() ? Number(olderDays) : undefined;
      const result = await wipeMemory({
        workspace,
        yes: true,
        kind: wipeKind,
        olderThanDays: older && Number.isFinite(older) ? older : undefined,
      });
      setMsg(`Wiped ${result.wiped} memories`);
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const statsLine = Object.entries(data.stats.byKind)
    .map(([k, n]) => `${k}=${n}`)
    .join(' · ');

  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <div>
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">Retention</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            Caps and prune for this workspace. Pinned memories skip prune and wipe.
          </p>
          <p className="mt-4 font-mono text-xs text-stone-500">
            total={data.stats.total} · pinned={data.stats.pinned}
            {statsLine ? ` · ${statsLine}` : ''}
          </p>
          <div className="mt-8 flex flex-col gap-5">
            {NUMBER_FIELDS.map(({ key, label, min, max, step }) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-sm font-medium text-stone-800">
                  {label}{' '}
                  <span className="font-mono text-stone-500">{String(draft[key])}</span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step ?? 1}
                  value={Number(draft[key])}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: Number(e.target.value) })
                  }
                  className="accent-stone-800"
                />
              </label>
            ))}
            <label className="flex items-center gap-3 text-sm text-stone-800">
              <input
                type="checkbox"
                checked={draft.autoPrune}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, autoPrune: e.target.checked })}
              />
              Auto-prune on save/recall
            </label>
            <label className="flex items-center gap-3 text-sm text-stone-800">
              <input
                type="checkbox"
                checked={draft.capture}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, capture: e.target.checked })}
              />
              Capture session memories (Stop hook)
            </label>
          </div>
          <div className="mt-8 flex flex-col gap-3">
            <MagneticButton disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save settings'}
            </MagneticButton>
            {msg ? <p className="text-sm tracking-tight text-emerald-700">{msg}</p> : null}
            {err ? <InlineError message={err} /> : null}
          </div>
        </Panel>
        <PanelLabel title="Lifecycle" body="Stored in ~/.fastpath/config.json under memory." />
      </div>

      <div>
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">Wipe</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            Destructive. Pinned rows are kept. Distill durable notes first if needed.
          </p>
          <div className="mt-8 flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium text-stone-800">Kind</span>
              <select
                className="rounded border border-stone-300 bg-white px-3 py-2"
                value={wipeKind}
                disabled={busy}
                onChange={(e) => setWipeKind(e.target.value as 'session' | 'all')}
              >
                <option value="session">session only</option>
                <option value="all">all kinds</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium text-stone-800">Older than (days, optional)</span>
              <input
                type="number"
                min={1}
                className="rounded border border-stone-300 bg-white px-3 py-2"
                value={olderDays}
                disabled={busy}
                onChange={(e) => setOlderDays(e.target.value)}
                placeholder="e.g. 60"
              />
            </label>
            <MagneticButton disabled={busy} onClick={() => void doWipe()}>
              Wipe now
            </MagneticButton>
            <MagneticButton
              disabled={busy}
              onClick={() => void onRun({ verb: 'memory-distill', workspace })}
            >
              Distill to steering
            </MagneticButton>
          </div>
        </Panel>
        <PanelLabel title="Wipe & distill" body="CLI: fastpath memory wipe --yes · memory distill" />
      </div>
    </div>
  );
}
