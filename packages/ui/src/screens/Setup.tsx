import { ArrowRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { ApiError } from '../api';
import type { JobSpec, StatePayload } from '../types';
import { Field, InlineError, Panel, PathInput, StepBadge, TextInput } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { isEphemeralWorkspace } from '../workspace';

export function SetupScreen({
  state,
  onRun,
  onRefresh,
}: {
  state: StatePayload;
  onRun: (spec: JobSpec) => Promise<number | null>;
  onRefresh: () => Promise<void>;
}) {
  const dest = state.defaultHome ?? state.home;
  const clone = state.checkout ?? '';
  const alreadyIn = Boolean(state.installed);
  const durableWired = state.wired.filter((p) => !isEphemeralWorkspace(p));

  const [from, setFrom] = useState(clone);
  const [workspace, setWorkspace] = useState(durableWired[0] ?? '');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function go(spec: JobSpec, label: string) {
    setError(null);
    setBusy(label);
    try {
      const code = await onRun(spec);
      if (code && code !== 0) setError('That step failed. Open the job log at the bottom for the error.');
      await onRefresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
      <ol className="flex flex-col gap-6">
        <li>
          <Panel>
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
          </Panel>
        </li>

        <li>
          <Panel>
            <div className="flex items-start gap-4">
              <StepBadge n={2} done={alreadyIn && dest !== from} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Copy into a separate home folder</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  FastPath keeps a working copy at the path below (npm install, models, CLI). Type that
                  path to confirm. This deletes whatever is already there.
                </p>
                {from && dest === from ? (
                  <p className="mt-3 text-sm leading-relaxed text-rose-800">
                    Home is the same folder as this clone. Pick a different FASTPATH_HOME (default
                    ~/kiro-fastpath) or you will wipe the git checkout.
                  </p>
                ) : null}
                <div className="mt-6 flex flex-col gap-4">
                  <Field
                    label="Type this path to confirm"
                    hint={`Destination: ${dest}`}
                    error={confirm && confirm !== dest ? 'Must match the destination exactly' : undefined}
                  >
                    <TextInput
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder={dest}
                    />
                  </Field>
                  <MagneticButton
                    disabled={!from || confirm !== dest || dest === from || Boolean(busy)}
                    onClick={() => go({ verb: 'install-home', from, confirm }, 'install-home')}
                  >
                    {busy === 'install-home' ? 'Copying…' : alreadyIn ? 'Re-copy into home' : 'Copy into home'}
                    <ArrowRight weight="regular" className="size-4" />
                  </MagneticButton>
                </div>
              </div>
            </div>
          </Panel>
        </li>

        <li>
          <Panel>
            <div className="flex items-start gap-4">
              <StepBadge n={3} done={alreadyIn} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Download local models</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  One-time download of MiniLM and parsers into ~/.fastpath. Needed before the index can
                  search your code.
                </p>
                <div className="mt-6">
                  <MagneticButton
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => go({ verb: 'warm' }, 'warm')}
                  >
                    {busy === 'warm' ? 'Downloading…' : 'Download models'}
                  </MagneticButton>
                </div>
              </div>
            </div>
          </Panel>
        </li>

        <li>
          <Panel>
            <div className="flex items-start gap-4">
              <StepBadge n={4} done={durableWired.length > 0} />
              <div className="min-w-0 flex-1">
                <h2 className="text-2xl tracking-tight text-stone-900">Connect the repo you work in</h2>
                <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">
                  Not this FastPath clone. The application Kiro should index — your product repo.
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
                    />
                  </Field>
                  <MagneticButton
                    disabled={!workspace || Boolean(busy)}
                    onClick={() => go({ verb: 'use', workspace }, 'use')}
                  >
                    {busy === 'use' ? 'Connecting…' : 'Connect this repo'}
                    <ArrowRight weight="regular" className="size-4" />
                  </MagneticButton>
                </div>
              </div>
            </div>
          </Panel>
        </li>
      </ol>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-8 lg:self-start">
        <Panel>
          <p className="text-sm font-medium tracking-tight text-stone-500">Where you are</p>
          <ul className="mt-4 divide-y divide-stone-200 text-sm">
            <StatusRow label="Clone" value={from || 'unknown'} />
            <StatusRow label="Home copy" value={alreadyIn ? `${dest} (ready)` : `${dest} (not copied yet)`} />
            <StatusRow
              label="Connected apps"
              value={durableWired.length ? durableWired.map(shortPath).join(', ') : 'none yet'}
            />
          </ul>
        </Panel>
        <p className="px-2 text-sm leading-relaxed text-stone-600">
          After step 4: open Repos, run Index, then Health. Watch the log pill at the bottom while a
          step runs.
        </p>
        {error ? <InlineError message={error} /> : null}
      </aside>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="py-3">
      <p className="text-stone-500">{label}</p>
      <p className="mt-1 break-all font-mono text-xs text-stone-900">{value}</p>
    </li>
  );
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}
