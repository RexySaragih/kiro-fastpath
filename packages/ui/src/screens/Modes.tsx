import { useCallback, useEffect, useState } from 'react';
import { fetchModes, putModes } from '../api';
import type {
  JobResult,
  JobSpec,
  ModeKey,
  ModeLevel,
  ModesPayload,
  ModeSettings,
} from '../types';
import { EmptyState, InlineError, Panel, PanelLabel } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { ScreenSkeleton } from '../components/Skeleton';
import { isEphemeralWorkspace } from '../workspace';

const LEVELS: ModeLevel[] = ['off', 'lite', 'full', 'ultra'];

const CAVEMAN_BLURB: Record<ModeLevel, string> = {
  off: 'Disabled — rules not installed',
  lite: 'Keep articles and full sentences. Drop filler, pleasantries, hedging, tool narration.',
  full: 'Drop articles when meaning stays clear. Fragments OK. Short synonyms.',
  ultra:
    'Strip conjunctions when cause-then-effect stays unambiguous. One word when one word is enough.',
};

const PONYTAIL_BLURB: Record<ModeLevel, string> = {
  off: 'Disabled — rules not installed',
  lite: 'Ladder is advisory. Small helpers allowed when they clarify. Ask before any new dependency.',
  full: 'Ladder is mandatory. No unrequested abstractions, dependencies, or boilerplate.',
  ultra:
    'One-line bias. No new file unless the change is impossible without it. Question every requirement before building.',
};

function blurb(key: ModeKey, level: ModeLevel): string {
  return key === 'caveman' ? CAVEMAN_BLURB[level] : PONYTAIL_BLURB[level];
}

function sourceLabel(
  key: ModeKey,
  data: ModesPayload,
  scope: 'workspace' | 'global',
): string {
  if (scope === 'global') {
    return data.global[key] !== undefined ? 'global default' : 'built-in default';
  }
  if (data.workspace[key] !== undefined) return 'workspace override';
  if (data.global[key] !== undefined) return 'from global default';
  return 'built-in default';
}

function LevelPicker({
  label,
  modeKey,
  value,
  description,
  source,
  onChange,
  inheritVisible,
  onInherit,
  disabled,
}: {
  label: string;
  modeKey: ModeKey;
  value: ModeLevel;
  description: string;
  source: string;
  onChange: (level: ModeLevel) => void;
  inheritVisible: boolean;
  onInherit: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium tracking-tight text-stone-800">{label}</p>
        <span className="font-mono text-[11px] tracking-wide text-stone-500 uppercase">
          {source}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex flex-wrap gap-1 rounded-2xl border border-stone-200 bg-stone-50 p-1"
        onKeyDown={(e) => {
          if (disabled) return;
          const idx = LEVELS.indexOf(value);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(LEVELS[(idx + 1) % LEVELS.length]!);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(LEVELS[(idx - 1 + LEVELS.length) % LEVELS.length]!);
          }
        }}
      >
        {LEVELS.map((level) => {
          const checked = value === level;
          return (
            <button
              key={`${modeKey}-${level}`}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(level)}
              className={`rounded-xl px-3 py-2 text-sm tracking-tight transition-colors ${
                checked
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900'
              } disabled:opacity-40`}
            >
              {level}
            </button>
          );
        })}
      </div>
      <p className="text-sm leading-relaxed text-stone-600">{description}</p>
      {inheritVisible ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onInherit}
          className="self-start text-sm text-accent underline-offset-2 hover:underline disabled:opacity-40"
        >
          Inherit
        </button>
      ) : null}
    </div>
  );
}

export function ModesScreen({
  workspace,
  onRun,
  onOpenRepos,
}: {
  workspace: string;
  onRun: (spec: JobSpec) => Promise<JobResult>;
  onOpenRepos?: () => void;
}) {
  const durable = Boolean(workspace) && !isEphemeralWorkspace(workspace);
  const [data, setData] = useState<ModesPayload | null>(null);
  const [wsDraft, setWsDraft] = useState<ModeSettings | null>(null);
  const [globalDraft, setGlobalDraft] = useState<ModeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyWs, setBusyWs] = useState(false);
  const [busyGlobal, setBusyGlobal] = useState(false);
  const [msgWs, setMsgWs] = useState<string | null>(null);
  const [msgGlobal, setMsgGlobal] = useState<string | null>(null);
  const [errWs, setErrWs] = useState<string | null>(null);
  const [errGlobal, setErrGlobal] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!durable) {
      setLoading(false);
      setData(null);
      return Promise.resolve();
    }
    setLoading(true);
    return fetchModes(workspace)
      .then((payload) => {
        setData(payload);
        setWsDraft({ ...payload.effective });
        setGlobalDraft({
          caveman: payload.global.caveman ?? 'full',
          ponytail: payload.global.ponytail ?? 'full',
        });
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
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
        body="Connect a real project in Repos first. Temp folders cannot own mode levels."
        action={
          onOpenRepos ? (
            <MagneticButton onClick={onOpenRepos}>Open Repos</MagneticButton>
          ) : undefined
        }
      />
    );
  }

  if (loading) return <ScreenSkeleton />;
  if (error || !data || !wsDraft || !globalDraft) {
    return (
      <EmptyState
        title="Modes could not load"
        body={error ?? 'No payload'}
        action={
          <MagneticButton onClick={() => void reload()}>Retry</MagneticButton>
        }
      />
    );
  }

  const wsDirty =
    wsDraft.caveman !== data.effective.caveman ||
    wsDraft.ponytail !== data.effective.ponytail;
  const globalDirty =
    globalDraft.caveman !== (data.global.caveman ?? 'full') ||
    globalDraft.ponytail !== (data.global.ponytail ?? 'full');

  async function saveWorkspace() {
    if (!data || !wsDraft) return;
    setBusyWs(true);
    setMsgWs(null);
    setErrWs(null);
    try {
      const body: {
        workspace: string;
        caveman?: ModeLevel;
        ponytail?: ModeLevel;
      } = { workspace };
      if (wsDraft.caveman !== data.effective.caveman) body.caveman = wsDraft.caveman;
      if (wsDraft.ponytail !== data.effective.ponytail) body.ponytail = wsDraft.ponytail;
      await putModes(body);
      if (!data.wired) {
        setMsgWs('Saved — connect this repo in Repos, then apply.');
        await reload();
        return;
      }
      const result = await onRun({ verb: 'rewire', workspace });
      if (result.code === 0) {
        setMsgWs('Applied — reload the Kiro window');
        await reload();
      } else {
        setErrWs(result.tail ?? `rewire failed (exit ${result.code})`);
      }
    } catch (err: unknown) {
      setErrWs(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyWs(false);
    }
  }

  async function saveGlobal() {
    if (!globalDraft) return;
    setBusyGlobal(true);
    setMsgGlobal(null);
    setErrGlobal(null);
    try {
      await putModes({
        caveman: globalDraft.caveman,
        ponytail: globalDraft.ponytail,
      });
      const result = await onRun({ verb: 'rewire', flags: ['--all'] });
      if (result.code === 0) {
        setMsgGlobal('Applied everywhere — reload Kiro windows');
        await reload();
      } else {
        setErrGlobal(result.tail ?? `rewire --all failed (exit ${result.code})`);
      }
    } catch (err: unknown) {
      setErrGlobal(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyGlobal(false);
    }
  }

  async function inheritKey(key: ModeKey) {
    setBusyWs(true);
    setErrWs(null);
    try {
      await putModes({ workspace, [key]: 'inherit' });
      await reload();
    } catch (err: unknown) {
      setErrWs(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyWs(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <div>
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">This repo</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            Overrides the default for the selected workspace. Save writes config, then rewires
            .kiro.
          </p>
          <div className="mt-8 flex flex-col gap-8">
            <LevelPicker
              label="Caveman — how it talks"
              modeKey="caveman"
              value={wsDraft.caveman}
              description={blurb('caveman', wsDraft.caveman)}
              source={sourceLabel('caveman', data, 'workspace')}
              onChange={(level) => setWsDraft({ ...wsDraft, caveman: level })}
              inheritVisible={data.workspace.caveman !== undefined}
              onInherit={() => void inheritKey('caveman')}
              disabled={busyWs}
            />
            <LevelPicker
              label="Ponytail — what it builds"
              modeKey="ponytail"
              value={wsDraft.ponytail}
              description={blurb('ponytail', wsDraft.ponytail)}
              source={sourceLabel('ponytail', data, 'workspace')}
              onChange={(level) => setWsDraft({ ...wsDraft, ponytail: level })}
              inheritVisible={data.workspace.ponytail !== undefined}
              onInherit={() => void inheritKey('ponytail')}
              disabled={busyWs}
            />
          </div>
          <div className="mt-8 flex flex-col gap-3">
            <MagneticButton
              disabled={!wsDirty || busyWs || !data.wired}
              onClick={() => void saveWorkspace()}
            >
              {busyWs ? 'Applying…' : 'Save & apply'}
            </MagneticButton>
            {!data.wired ? (
              <p className="text-xs leading-relaxed text-stone-500">
                Connect this repo in Repos first
              </p>
            ) : null}
            {msgWs ? (
              <p className="text-sm tracking-tight text-emerald-700">{msgWs}</p>
            ) : null}
            {errWs ? <InlineError message={errWs} /> : null}
          </div>
        </Panel>
        <PanelLabel
          title="This repo"
          body="Workspace overrides beat the global default."
        />
      </div>

      <div>
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">Default for all repos</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            Global default when a repo has no override. Save applies via rewire --all.
          </p>
          <div className="mt-8 flex flex-col gap-8">
            <LevelPicker
              label="Caveman — how it talks"
              modeKey="caveman"
              value={globalDraft.caveman}
              description={blurb('caveman', globalDraft.caveman)}
              source={sourceLabel('caveman', data, 'global')}
              onChange={(level) => setGlobalDraft({ ...globalDraft, caveman: level })}
              inheritVisible={false}
              onInherit={() => undefined}
              disabled={busyGlobal}
            />
            <LevelPicker
              label="Ponytail — what it builds"
              modeKey="ponytail"
              value={globalDraft.ponytail}
              description={blurb('ponytail', globalDraft.ponytail)}
              source={sourceLabel('ponytail', data, 'global')}
              onChange={(level) => setGlobalDraft({ ...globalDraft, ponytail: level })}
              inheritVisible={false}
              onInherit={() => undefined}
              disabled={busyGlobal}
            />
          </div>
          <div className="mt-8 flex flex-col gap-3">
            <MagneticButton
              disabled={!globalDirty || busyGlobal}
              onClick={() => void saveGlobal()}
            >
              {busyGlobal ? 'Applying…' : 'Save & apply everywhere'}
            </MagneticButton>
            {msgGlobal ? (
              <p className="text-sm tracking-tight text-emerald-700">{msgGlobal}</p>
            ) : null}
            {errGlobal ? <InlineError message={errGlobal} /> : null}
          </div>
        </Panel>
        <PanelLabel
          title="Default for all repos"
          body="Sets ~/.fastpath/config.json modes, then rewires every wired repo."
        />
      </div>
    </div>
  );
}
