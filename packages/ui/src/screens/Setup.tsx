import { ArrowRight, CheckCircle } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { JobResult, JobSpec, StatePayload } from '../types';
import { Field, InlineError, Panel, PathInput, StepBadge, TextInput } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { baseName, isEphemeralWorkspace } from '../workspace';

type StepId = 'copy' | 'models' | 'connect';
type StepState = 'done' | 'active' | 'locked';

function stepStates(done: Record<StepId, boolean>): Record<StepId, StepState> {
  const order: StepId[] = ['copy', 'models', 'connect'];
  const active = order.find((id) => !done[id]);
  const states = {} as Record<StepId, StepState>;
  let past = true;
  for (const id of order) {
    if (done[id]) {
      states[id] = 'done';
    } else if (id === active && past) {
      states[id] = 'active';
      past = false;
    } else {
      states[id] = 'locked';
    }
  }
  return states;
}

export function SetupScreen({
  state,
  onRun,
  onRefresh,
  onDone,
}: {
  state: StatePayload;
  onRun: (spec: JobSpec) => Promise<JobResult>;
  onRefresh: () => Promise<void>;
  onDone: () => void;
}) {
  const dest = state.defaultHome ?? state.home;
  const clone = state.checkout ?? '';
  const alreadyIn = Boolean(state.installed);
  const modelsReady = Boolean(state.modelsReady);
  const durableWired = state.wired.filter((p) => !isEphemeralWorkspace(p));

  const [from, setFrom] = useState(clone);
  const [workspace, setWorkspace] = useState(durableWired[0] ?? '');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState(false);
  const [connected, setConnected] = useState(false);

  const done: Record<StepId, boolean> = {
    copy: alreadyIn,
    models: modelsReady,
    connect: durableWired.length > 0,
  };
  const states = stepStates(done);
  const allDone = done.copy && done.models && done.connect;

  const activeRef = useRef<HTMLLIElement>(null);
  const activeStep = (Object.keys(states) as StepId[]).find(
    (id) => states[id] === 'active',
  );
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeStep]);

  async function go(spec: JobSpec, label: string): Promise<boolean> {
    setError(null);
    setBusy(label);
    try {
      const { code, tail } = await onRun(spec);
      await onRefresh();
      if (code && code !== 0) {
        setError(tail ? `${label} failed: ${tail}` : `${label} failed — see the job log below.`);
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function connectAndIndex() {
    if (!workspace) return;
    const wired = await go({ verb: 'use', workspace }, 'connect');
    if (!wired) return;
    const indexed = await go({ verb: 'index', workspace }, 'index');
    if (indexed) setConnected(true);
  }

  if (allDone && !maintenance) {
    return (
      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <Panel>
          <p className="flex items-center gap-2 text-sm tracking-tight text-emerald-700">
            <CheckCircle weight="regular" className="size-4" />
            Setup complete
          </p>
          <h2 className="mt-3 text-2xl tracking-tight text-stone-900">
            FastPath v{state.version} is ready
          </h2>
          <ul className="mt-6 divide-y divide-stone-200 text-sm">
            <StatusRow label="Home copy" value={state.home} />
            <StatusRow label="Models" value={state.modelCache ?? 'cached'} />
            <StatusRow
              label="Connected apps"
              value={durableWired.map(baseName).join(', ')}
            />
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <MagneticButton onClick={onDone}>
              Manage repos
              <ArrowRight weight="regular" className="size-4" />
            </MagneticButton>
            <MagneticButton
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => go({ verb: 'warm' }, 'warm')}
            >
              {busy === 'warm' ? 'Downloading…' : 'Re-download models'}
            </MagneticButton>
            <MagneticButton variant="ghost" onClick={() => setMaintenance(true)}>
              Re-run setup
            </MagneticButton>
          </div>
          {error ? (
            <div className="mt-6">
              <InlineError message={error} />
            </div>
          ) : null}
        </Panel>
        <p className="px-2 text-sm leading-relaxed text-stone-600 lg:sticky lg:top-8 lg:self-start">
          Add or index repos from the Repos screen. Health and Signal follow the workspace
          picked in the left rail.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
      <ol className="flex flex-col gap-6">
        <li>
          <StepPanel state="done">
            <div className="flex items-start gap-4">
              <StepBadge n={1} done />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">You cloned FastPath</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  This folder is the source. Keep working in it. Do not install on top of it — that wipe
                  would delete your clone.
                </p>
                <p className="mt-4 break-all font-mono text-sm text-stone-800">
                  {from || 'This UI is running from the FastPath checkout.'}
                </p>
                <div className="mt-4">
                  <Field
                    label="Path of this clone"
                    hint="Leave this if you just ran git clone. Browse opens a native folder dialog."
                  >
                    <PathInput
                      value={from}
                      onChange={setFrom}
                      placeholder="/Users/you/Documents/kiro-fastpath"
                    />
                  </Field>
                </div>
              </div>
            </div>
          </StepPanel>
        </li>

        <li ref={activeStep === 'copy' ? activeRef : undefined}>
          <StepPanel state={states.copy}>
            <div className="flex items-start gap-4">
              <StepBadge n={2} done={states.copy === 'done'} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Copy into a separate home folder</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  FastPath keeps a working copy at{' '}
                  <span className="break-all font-mono text-sm text-stone-800">{dest}</span>. Type the
                  folder name to confirm. This deletes whatever is already there.
                </p>
                {from && dest === from ? (
                  <p className="mt-3 text-sm leading-relaxed text-rose-800">
                    Home is the same folder as this clone. Pick a different FASTPATH_HOME (default
                    ~/kiro-fastpath) or you will wipe the git checkout.
                  </p>
                ) : null}
                <div className="mt-6 flex flex-col gap-4">
                  <Field
                    label={`Type "${baseName(dest)}" to confirm`}
                    hint={`Destination: ${dest}`}
                    error={
                      confirm && confirm !== baseName(dest)
                        ? 'Must match the folder name exactly'
                        : undefined
                    }
                  >
                    <TextInput
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder={baseName(dest)}
                      disabled={states.copy === 'locked'}
                    />
                  </Field>
                  <MagneticButton
                    disabled={
                      !from ||
                      confirm !== baseName(dest) ||
                      dest === from ||
                      Boolean(busy) ||
                      states.copy === 'locked'
                    }
                    onClick={() => go({ verb: 'install-home', from, confirm: dest }, 'install-home')}
                  >
                    {busy === 'install-home' ? 'Copying…' : alreadyIn ? 'Re-copy into home' : 'Copy into home'}
                    <ArrowRight weight="regular" className="size-4" />
                  </MagneticButton>
                </div>
              </div>
            </div>
          </StepPanel>
        </li>

        <li ref={activeStep === 'models' ? activeRef : undefined}>
          <StepPanel state={states.models}>
            <div className="flex items-start gap-4">
              <StepBadge n={3} done={states.models === 'done'} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Download local models</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  One-time download of MiniLM and parsers into ~/.fastpath. Needed before the index can
                  search your code.
                </p>
                {states.models === 'done' && state.modelCache ? (
                  <p className="mt-3 break-all font-mono text-xs text-stone-500">
                    Cached at {state.modelCache}
                  </p>
                ) : null}
                <div className="mt-6">
                  <MagneticButton
                    variant={states.models === 'active' ? 'primary' : 'ghost'}
                    disabled={Boolean(busy) || states.models === 'locked'}
                    onClick={() => go({ verb: 'warm' }, 'warm')}
                  >
                    {busy === 'warm'
                      ? 'Downloading…'
                      : states.models === 'done'
                        ? 'Re-download models'
                        : 'Download models'}
                  </MagneticButton>
                </div>
              </div>
            </div>
          </StepPanel>
        </li>

        <li ref={activeStep === 'connect' ? activeRef : undefined}>
          <StepPanel state={states.connect}>
            <div className="flex items-start gap-4">
              <StepBadge n={4} done={states.connect === 'done'} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Connect the repo you work in</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  Not this FastPath clone. The application Kiro should index — your product repo. This
                  wires it and builds the first index in one go.
                </p>
                <div className="mt-6 flex flex-col gap-4">
                  <Field
                    label="Application repo path"
                    hint="Browse the repo folder, or type an absolute path."
                  >
                    <PathInput
                      value={workspace}
                      onChange={setWorkspace}
                      placeholder="/Users/you/Documents/my-app"
                      disabled={states.connect === 'locked'}
                    />
                  </Field>
                  <MagneticButton
                    disabled={!workspace || Boolean(busy) || states.connect === 'locked'}
                    onClick={() => void connectAndIndex()}
                  >
                    {busy === 'connect'
                      ? 'Connecting…'
                      : busy === 'index'
                        ? 'Indexing…'
                        : 'Connect & index'}
                    <ArrowRight weight="regular" className="size-4" />
                  </MagneticButton>
                </div>
              </div>
            </div>
          </StepPanel>
        </li>

        {connected || allDone ? (
          <li>
            <Panel className="border-emerald-200 bg-emerald-50/60">
              <p className="flex items-center gap-2 text-sm tracking-tight text-emerald-800">
                <CheckCircle weight="regular" className="size-4" />
                All set — your repo is connected and indexed.
              </p>
              <div className="mt-4">
                <MagneticButton onClick={onDone}>
                  Open Repos
                  <ArrowRight weight="regular" className="size-4" />
                </MagneticButton>
              </div>
            </Panel>
          </li>
        ) : null}
      </ol>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-8 lg:self-start">
        <Panel>
          <p className="text-sm font-medium tracking-tight text-stone-500">Where you are</p>
          <ul className="mt-4 divide-y divide-stone-200 text-sm">
            <StatusRow label="Clone" value={from || 'unknown'} />
            <StatusRow label="Home copy" value={alreadyIn ? `${dest} (ready)` : `${dest} (not copied yet)`} />
            <StatusRow
              label="Models"
              value={modelsReady ? 'downloaded' : 'not downloaded yet'}
            />
            <StatusRow
              label="Connected apps"
              value={durableWired.length ? durableWired.map(baseName).join(', ') : 'none yet'}
            />
          </ul>
        </Panel>
        <p className="px-2 text-sm leading-relaxed text-stone-600">
          Steps unlock in order and tick themselves as each one finishes. Watch the log pill at the
          bottom while a step runs.
        </p>
        {error ? <InlineError message={error} /> : null}
      </aside>
    </div>
  );
}

function StepPanel({ state, children }: { state: StepState; children: ReactNode }) {
  const ring =
    state === 'active'
      ? 'ring-2 ring-accent/40'
      : state === 'locked'
        ? 'opacity-50'
        : '';
  return <Panel className={ring}>{children}</Panel>;
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="py-3">
      <p className="text-stone-500">{label}</p>
      <p className="mt-1 break-all font-mono text-xs text-stone-900">{value}</p>
    </li>
  );
}
