import { useCallback, useEffect, useState } from 'react';
import { fetchModes, fetchPrefs, putModes, putPrefs } from '../api';
import type {
  EffortLevel,
  JobResult,
  JobSpec,
  ModeKey,
  ModeLevel,
  ModesPayload,
  ModeSettings,
  PrefsPayload,
} from '../types';
import { EmptyState, InlineError, Panel, PanelLabel } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { ScreenSkeleton } from '../components/Skeleton';
import { isEphemeralWorkspace } from '../workspace';

const LEVELS: ModeLevel[] = ['off', 'lite', 'full', 'ultra'];
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high'];

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
  const [prefs, setPrefs] = useState<PrefsPayload | null>(null);
  const [wsDraft, setWsDraft] = useState<ModeSettings | null>(null);
  const [globalDraft, setGlobalDraft] = useState<ModeSettings | null>(null);
  const [injectDraft, setInjectDraft] = useState<PrefsPayload['effective']['inject'] | null>(
    null,
  );
  const [effortDraft, setEffortDraft] = useState<
    PrefsPayload['effective']['effortReminders'] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyWs, setBusyWs] = useState(false);
  const [busyGlobal, setBusyGlobal] = useState(false);
  const [busyPrefs, setBusyPrefs] = useState(false);
  const [msgWs, setMsgWs] = useState<string | null>(null);
  const [msgGlobal, setMsgGlobal] = useState<string | null>(null);
  const [msgPrefs, setMsgPrefs] = useState<string | null>(null);
  const [errWs, setErrWs] = useState<string | null>(null);
  const [errGlobal, setErrGlobal] = useState<string | null>(null);
  const [errPrefs, setErrPrefs] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!durable) {
      setLoading(false);
      setData(null);
      setPrefs(null);
      return Promise.resolve();
    }
    setLoading(true);
    return Promise.all([fetchModes(workspace), fetchPrefs(workspace)])
      .then(([modesPayload, prefsPayload]) => {
        setData(modesPayload);
        setPrefs(prefsPayload);
        setWsDraft({ ...modesPayload.effective });
        setGlobalDraft({
          caveman: modesPayload.global.caveman ?? 'full',
          ponytail: modesPayload.global.ponytail ?? 'full',
        });
        setInjectDraft({ ...prefsPayload.effective.inject });
        setEffortDraft({ ...prefsPayload.effective.effortReminders });
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
  if (error || !data || !wsDraft || !globalDraft || !prefs || !injectDraft || !effortDraft) {
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
  const prefsDirty =
    injectDraft.maxHits !== prefs.effective.inject.maxHits ||
    injectDraft.contextChunks !== prefs.effective.inject.contextChunks ||
    injectDraft.tokenBudget !== prefs.effective.inject.tokenBudget ||
    effortDraft.scout !== prefs.effective.effortReminders.scout ||
    effortDraft.architect !== prefs.effective.effortReminders.architect;

  async function applyPreset(name: string) {
    const preset = data.presets?.[name];
    if (!preset) return;
    setBusyWs(true);
    setErrWs(null);
    setMsgWs(null);
    try {
      await putModes({
        workspace,
        caveman: preset.caveman,
        ponytail: preset.ponytail,
      });
      if (data.wired) {
        const result = await onRun({ verb: 'rewire', workspace });
        if (result.code !== 0) {
          setErrWs(result.tail ?? `rewire failed (exit ${result.code})`);
          return;
        }
      }
      setMsgWs(`Preset ${name} applied`);
      await reload();
    } catch (err: unknown) {
      setErrWs(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyWs(false);
    }
  }

  async function resetWorkspaceModes() {
    setBusyWs(true);
    setErrWs(null);
    setMsgWs(null);
    try {
      await putModes({ workspace, caveman: 'inherit', ponytail: 'inherit' });
      if (data.wired) {
        const result = await onRun({ verb: 'rewire', workspace });
        if (result.code !== 0) {
          setErrWs(result.tail ?? `rewire failed (exit ${result.code})`);
          return;
        }
      }
      setMsgWs('Reset to defaults');
      await reload();
    } catch (err: unknown) {
      setErrWs(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyWs(false);
    }
  }

  async function savePrefs() {
    setBusyPrefs(true);
    setMsgPrefs(null);
    setErrPrefs(null);
    try {
      await putPrefs({
        workspace,
        inject: injectDraft,
        effortReminders: effortDraft,
      });
      if (data.wired) {
        const result = await onRun({ verb: 'rewire', workspace });
        if (result.code !== 0) {
          setErrPrefs(result.tail ?? `rewire failed (exit ${result.code})`);
          return;
        }
      }
      setMsgPrefs('Saved — reload Kiro for agent effort text');
      await reload();
    } catch (err: unknown) {
      setErrPrefs(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPrefs(false);
    }
  }

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

      <div className="lg:col-span-2">
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">Presets & reset</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            One-click talk/code pairs. Reset clears this repo&apos;s overrides.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {Object.entries(data.presets ?? {}).map(([name, p]) => (
              <MagneticButton
                key={name}
                disabled={busyWs}
                onClick={() => void applyPreset(name)}
              >
                {p.label}
              </MagneticButton>
            ))}
            <MagneticButton disabled={busyWs} onClick={() => void resetWorkspaceModes()}>
              Reset this repo
            </MagneticButton>
          </div>
          {msgWs ? (
            <p className="mt-4 text-sm tracking-tight text-emerald-700">{msgWs}</p>
          ) : null}
          {errWs ? (
            <div className="mt-4">
              <InlineError message={errWs} />
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="lg:col-span-2">
        <Panel>
          <h2 className="text-2xl tracking-tight text-stone-900">Inject pack & effort reminders</h2>
          <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-stone-600">
            Pack size for prompt inject. Effort is reminder-only — run /effort in the Kiro session.
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {(
              [
                ['maxHits', 'Max hits', 1, 12],
                ['contextChunks', 'Context chunks', 1, 12],
                ['tokenBudget', 'Token budget', 400, 4000],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key} className="flex flex-col gap-2">
                <span className="text-sm font-medium text-stone-800">
                  {label}{' '}
                  <span className="font-mono text-stone-500">{injectDraft[key]}</span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={key === 'tokenBudget' ? 100 : 1}
                  value={injectDraft[key]}
                  disabled={busyPrefs}
                  onChange={(e) =>
                    setInjectDraft({ ...injectDraft, [key]: Number(e.target.value) })
                  }
                  className="accent-stone-800"
                />
              </label>
            ))}
          </div>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {(
              [
                ['scout', 'Scout reminder'],
                ['architect', 'Architect reminder'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-2">
                <span className="text-sm font-medium text-stone-800">{label}</span>
                <select
                  className="rounded border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800"
                  value={effortDraft[key]}
                  disabled={busyPrefs}
                  onChange={(e) =>
                    setEffortDraft({
                      ...effortDraft,
                      [key]: e.target.value as EffortLevel,
                    })
                  }
                >
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      /effort {e}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-3">
            <MagneticButton
              disabled={!prefsDirty || busyPrefs}
              onClick={() => void savePrefs()}
            >
              {busyPrefs ? 'Saving…' : 'Save inject & reminders'}
            </MagneticButton>
            {msgPrefs ? (
              <p className="text-sm tracking-tight text-emerald-700">{msgPrefs}</p>
            ) : null}
            {errPrefs ? <InlineError message={errPrefs} /> : null}
          </div>
        </Panel>
        <PanelLabel
          title="Inject & effort"
          body="Reminder only — Kiro effort is session-level, not per-agent."
        />
      </div>
    </div>
  );
}
