import { CaretDown, Eye, GitDiff, Plugs, Plus, Trash, Waveform } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ApiError, pickFolder } from '../api';
import type { ActiveJob, JobResult, JobSpec, RepoIndexStats, StatePayload } from '../types';
import { EmptyState, Field, InlineError, Panel, PanelLabel, TextInput } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { baseName, splitWired, timeAgo } from '../workspace';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

export function ReposScreen({
  state,
  jobs,
  onRun,
  onRefresh,
  onSelect,
}: {
  state: StatePayload;
  jobs: ActiveJob[];
  onRun: (spec: JobSpec) => Promise<JobResult>;
  onRefresh: () => Promise<void>;
  onSelect: (path: string) => void;
}) {
  const { durable, ephemeral } = splitWired(state.config.workspaces);
  const repoStats = state.repoStats ?? {};
  const [selected, setSelected] = useState<string | null>(durable[0]?.[0] ?? null);
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [mode, setMode] = useState<'rebuild' | 'unwire' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const watching = jobs.find((j) => j.verb === 'watch' && j.running && j.workspace === selected);

  function choose(path: string) {
    setSelected(path);
    setMode(null);
    setConfirm('');
    onSelect(path);
  }

  async function go(spec: JobSpec): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      const { code, tail } = await onRun(spec);
      await onRefresh();
      if (code && code !== 0) {
        setError(tail ? `${spec.verb} failed: ${tail}` : `${spec.verb} failed`);
        return false;
      }
      if (spec.verb === 'unwire' && spec.workspace === selected) {
        setSelected(durable.find(([p]) => p !== spec.workspace)?.[0] ?? null);
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.confirmTarget) setConfirm('');
      } else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addRepo() {
    setError(null);
    setAdding(true);
    try {
      const path = await pickFolder();
      if (!path) return;
      const wired = await go({ verb: 'use', workspace: path });
      if (wired) {
        choose(path);
        await go({ verb: 'index', workspace: path });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  const addButton = (
    <MagneticButton disabled={busy || adding} onClick={() => void addRepo()}>
      <Plus weight="regular" className="size-4" />
      {adding ? 'Adding…' : 'Add a repo'}
    </MagneticButton>
  );

  if (durable.length === 0 && ephemeral.length === 0) {
    return (
      <EmptyState
        title="No wired workspaces"
        body="Pick a repo folder to connect and index it, or run the CLI."
        command="fastpath use /path/to/your-repo"
        action={addButton}
      />
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
      <div>
        <div className="mb-6 flex justify-end">{addButton}</div>
        {durable.length === 0 ? (
          <EmptyState
            title="No durable workspaces"
            body="Wired entries are test/temp dirs (same bucket viz calls Ephemeral). Add a real repo, or remove the leftovers."
            command="fastpath use /path/to/your-repo"
          />
        ) : (
          <>
            <Panel className="overflow-hidden p-0">
              <ul className="divide-y divide-stone-200">
                {durable.map(([path, meta], i) => (
                  <RepoRow
                    key={path}
                    path={path}
                    wiredAt={meta.wiredAt}
                    stats={repoStats[path]}
                    watching={jobs.some(
                      (j) => j.verb === 'watch' && j.running && j.workspace === path,
                    )}
                    selected={selected === path}
                    index={i}
                    onClick={() => choose(path)}
                  />
                ))}
              </ul>
            </Panel>
            <PanelLabel
              title="Wired registry"
              body="Real repos from ~/.fastpath/config.json. Temp doctor/install dirs sit under Ephemeral."
            />
          </>
        )}

        {ephemeral.length > 0 ? (
          <div className="mt-8">
            <Panel className="overflow-hidden p-0">
              <button
                type="button"
                onClick={() => setEphemeralOpen((v) => !v)}
                className="flex w-full items-center gap-3 px-8 py-5 text-left text-sm text-stone-600 active:scale-[0.99]"
              >
                <motion.span animate={{ rotate: ephemeralOpen ? 0 : -90 }} transition={SPRING}>
                  <CaretDown weight="regular" className="size-4" />
                </motion.span>
                Ephemeral ({ephemeral.length})
              </button>
              <AnimatePresence initial={false}>
                {ephemeralOpen ? (
                  <motion.ul
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={SPRING}
                    className="divide-y divide-stone-200 overflow-hidden border-t border-stone-200"
                  >
                    {ephemeral.map(([path, meta], i) => (
                      <RepoRow
                        key={path}
                        path={path}
                        wiredAt={meta.wiredAt}
                        selected={selected === path}
                        index={i}
                        onClick={() => choose(path)}
                      />
                    ))}
                  </motion.ul>
                ) : null}
              </AnimatePresence>
            </Panel>
            <PanelLabel
              title="Ephemeral"
              body="Test leftovers under /var/folders and /tmp. Remove them to drop them from config.json — the dir does not need to still exist."
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-6">
        {selected ? (
          <>
            <Panel>
              <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">Actions</p>
              <p className="mt-2 font-mono text-xs break-all text-stone-600">{selected}</p>
              <div className="mt-6 grid grid-cols-1 gap-3">
                <MagneticButton disabled={busy} onClick={() => go({ verb: 'index', workspace: selected })}>
                  Update index
                </MagneticButton>
                <MagneticButton
                  variant="ghost"
                  disabled={busy}
                  onClick={() => go({ verb: 'index', workspace: selected, flags: ['--git'] })}
                >
                  <GitDiff weight="regular" className="size-4" />
                  Index git history
                </MagneticButton>
                <MagneticButton
                  variant="ghost"
                  disabled={busy || Boolean(watching)}
                  onClick={() => go({ verb: 'watch', workspace: selected })}
                >
                  <Waveform weight="regular" className="size-4" />
                  {watching ? 'Watching for changes' : 'Watch for changes'}
                </MagneticButton>
                <MagneticButton
                  variant="ghost"
                  disabled={busy}
                  onClick={() => go({ verb: 'use', workspace: selected })}
                >
                  <Plugs weight="regular" className="size-4" />
                  Reconnect
                </MagneticButton>
                <MagneticButton variant="ghost" disabled={busy} onClick={() => setMode('rebuild')}>
                  Full rebuild
                </MagneticButton>
                <MagneticButton variant="danger" disabled={busy} onClick={() => setMode('unwire')}>
                  <Trash weight="regular" className="size-4" />
                  Remove from FastPath
                </MagneticButton>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-stone-500">
                Update is incremental. Full rebuild rescans from scratch. Remove only unwires — your
                code stays untouched.
              </p>
            </Panel>
            <PanelLabel title="Jobs" body="Long runs stream into the dock. Watch stays until you stop it." />
          </>
        ) : null}

        {error ? <InlineError message={error} /> : null}

        <p className="flex items-center gap-2 px-2 text-xs text-stone-600">
          <Eye weight="regular" className="size-3.5" />
          Last workspace: {state.config.lastWorkspace ?? 'none'}
        </p>
      </div>

      <ConfirmDialog
        mode={mode}
        path={selected}
        confirm={confirm}
        busy={busy}
        onConfirmChange={setConfirm}
        onCancel={() => {
          setMode(null);
          setConfirm('');
        }}
        onOk={() => {
          if (!selected || !mode) return;
          const spec: JobSpec =
            mode === 'rebuild'
              ? {
                  verb: 'index',
                  workspace: selected,
                  flags: ['--rebuild'],
                  confirm: selected,
                }
              : { verb: 'unwire', workspace: selected, confirm: selected };
          void go(spec).then(() => {
            setMode(null);
            setConfirm('');
          });
        }}
      />
    </div>
  );
}

function ConfirmDialog({
  mode,
  path,
  confirm,
  busy,
  onConfirmChange,
  onCancel,
  onOk,
}: {
  mode: 'rebuild' | 'unwire' | null;
  path: string | null;
  confirm: string;
  busy: boolean;
  onConfirmChange: (v: string) => void;
  onCancel: () => void;
  onOk: () => void;
}) {
  const folder = path ? baseName(path) : '';
  return (
    <AnimatePresence>
      {mode && path ? (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={SPRING}
        >
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute inset-0 bg-stone-900/40"
            onClick={onCancel}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={SPRING}
            className="relative z-[1] w-full max-w-lg rounded-[2rem] border border-stone-200 bg-white p-8 shadow-[0_20px_40px_-15px_rgba(28,25,23,0.2)]"
          >
            <h2 id="confirm-title" className="text-2xl tracking-tight text-stone-900">
              {mode === 'unwire' ? 'Remove this repo from FastPath?' : 'Rebuild the index?'}
            </h2>
            <p className="mt-2 text-base leading-relaxed text-stone-600">
              {mode === 'unwire'
                ? 'Deletes FastPath wiring in that folder. Your code is untouched.'
                : 'Deletes the current index and scans the repo from scratch.'}
            </p>
            <p className="mt-4 break-all font-mono text-sm text-stone-900">{path}</p>
            <div className="mt-6">
              <Field label={`Type "${folder}" to confirm`}>
                <TextInput
                  autoFocus
                  value={confirm}
                  onChange={(e) => onConfirmChange(e.target.value)}
                  placeholder={folder}
                />
              </Field>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <MagneticButton
                variant={mode === 'unwire' ? 'danger' : 'primary'}
                disabled={busy || confirm !== folder}
                onClick={onOk}
              >
                {busy ? 'Working…' : mode === 'unwire' ? 'Remove' : 'Rebuild'}
              </MagneticButton>
              <MagneticButton variant="ghost" onClick={onCancel}>
                Cancel
              </MagneticButton>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function RepoRow({
  path,
  wiredAt,
  stats,
  watching,
  selected,
  index,
  onClick,
}: {
  path: string;
  wiredAt: string;
  stats?: RepoIndexStats;
  watching?: boolean;
  selected: boolean;
  index: number;
  onClick: () => void;
}) {
  const indexed = Boolean(stats?.indexedAt);
  return (
    <motion.li
      custom={index}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING, delay: index * 0.05 }}
    >
      <button
        type="button"
        onClick={onClick}
        className={`w-full px-8 py-5 text-left active:scale-[0.99] ${
          selected ? 'bg-amber-50' : ''
        }`}
      >
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 font-mono text-sm break-all text-stone-900">{path}</p>
          {watching ? (
            <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[10px] text-emerald-800">
              watching
            </span>
          ) : null}
          {stats ? (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                indexed ? 'bg-stone-100 text-stone-600' : 'bg-amber-100 text-amber-800'
              }`}
            >
              {timeAgo(stats.indexedAt)}
            </span>
          ) : null}
        </div>
        <p className="mt-1 font-mono text-[11px] text-stone-500">
          wired {wiredAt}
          {stats && stats.files > 0 ? ` · ${stats.files} files · ${stats.symbols} symbols` : ''}
        </p>
      </button>
    </motion.li>
  );
}
