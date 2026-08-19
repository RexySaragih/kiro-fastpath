import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureToken, fetchState, killJob, patchJob, postJob, streamJob } from './api';
import { JobDock } from './components/JobDock';
import { Rail } from './components/Rail';
import { ScreenSkeleton } from './components/Skeleton';
import { HealthScreen } from './screens/Health';
import { ReposScreen } from './screens/Repos';
import { SetupScreen } from './screens/Setup';
import { SignalScreen } from './screens/Signal';
import type { ActiveJob, JobResult, JobSpec, ScreenId, StatePayload } from './types';
import { isEphemeralWorkspace, pickDurableWorkspace } from './workspace';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };
const WORKSPACE_KEY = 'fastpath.ui.workspace';

const TITLES: Record<ScreenId, { h: string; p: string }> = {
  setup: {
    h: 'After you clone: copy, download, connect.',
    p: 'This page talks to FastPath on this machine only.',
  },
  repos: {
    h: 'Repos Kiro can search',
    p: 'Real projects you connected. Temp test folders stay under Ephemeral.',
  },
  health: {
    h: 'Is this repo ready?',
    p: 'Doctor checks the index, hooks, and agents for the selected workspace.',
  },
  signal: {
    h: 'Did FastPath save tokens?',
    p: 'Hit rate and ledger from this machine’s journal.',
  },
};

const SETUP_DONE_TITLE = {
  h: 'FastPath is installed.',
  p: 'Everything below is maintenance. Manage projects from Repos.',
};

function isSetupComplete(state: StatePayload): boolean {
  const durableWired = state.wired.filter((p) => !isEphemeralWorkspace(p));
  return Boolean(state.installed) && Boolean(state.modelsReady) && durableWired.length > 0;
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>('setup');
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [workspace, setWorkspace] = useState(
    () => sessionStorage.getItem(WORKSPACE_KEY) ?? '',
  );
  const landed = useRef(false);

  const selectWorkspace = useCallback((path: string) => {
    setWorkspace(path);
    sessionStorage.setItem(WORKSPACE_KEY, path);
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchState();
    setState(next);
    setWorkspace((current) => {
      if (current && !isEphemeralWorkspace(current) && next.wired.includes(current)) {
        return current;
      }
      const picked = pickDurableWorkspace(next);
      if (picked) sessionStorage.setItem(WORKSPACE_KEY, picked);
      return picked;
    });
    if (!landed.current) {
      landed.current = true;
      if (isSetupComplete(next)) setScreen('repos');
    }
  }, []);

  useEffect(() => {
    captureToken();
    refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refresh]);

  const runJob = useCallback(async (spec: JobSpec): Promise<JobResult> => {
    const { jobId } = await postJob(spec);
    const job: ActiveJob = {
      id: jobId,
      verb: spec.verb,
      workspace: spec.workspace,
      running: true,
      lines: [],
      exitCode: null,
    };
    setJobs((prev) => [job, ...prev].slice(0, 8));
    let tail: string | null = null;
    return new Promise((resolve, reject) => {
      streamJob(
        jobId,
        (line) => {
          if (line.stream === 'stderr' && line.line.trim()) tail = line.line.trim();
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId ? { ...j, lines: [...j.lines, line].slice(-400) } : j,
            ),
          );
        },
        (code) => {
          setJobs((prev) => patchJob(prev, jobId, { running: false, exitCode: code }));
          resolve({ code, tail });
        },
      ).catch(reject);
    });
  }, []);

  const onKill = useCallback(async (id: string) => {
    await killJob(id);
  }, []);

  const setupDone = state ? isSetupComplete(state) : false;
  const title = screen === 'setup' && setupDone ? SETUP_DONE_TITLE : TITLES[screen];
  const showsWorkspace = screen === 'health' || screen === 'signal';
  const activeWorkspace = workspace || state?.home || '';
  const durableWired = state ? state.wired.filter((p) => !isEphemeralWorkspace(p)) : [];

  return (
    <div className="relative min-h-[100dvh] bg-canvas text-stone-900">
      <div className="grain" />
      <div className="mx-auto grid min-h-[100dvh] max-w-[1400px] grid-cols-1 gap-8 px-4 py-8 pb-28 md:grid-cols-[13rem_1fr] md:px-8">
        <Rail
          screen={screen}
          onChange={setScreen}
          version={state?.version ?? '—'}
          workspaces={durableWired}
          workspace={workspace}
          onWorkspace={selectWorkspace}
        />
        <main>
          <header className="mb-10 max-w-[40rem]">
            <h1 className="text-4xl tracking-tighter text-stone-900 md:text-5xl">
              {title.h}
            </h1>
            <p className="mt-3 max-w-[65ch] text-base leading-relaxed text-stone-600">
              {title.p}
            </p>
            {showsWorkspace && activeWorkspace ? (
              <p className="mt-2 break-all font-mono text-xs text-stone-500">
                {activeWorkspace}
              </p>
            ) : null}
          </header>
          {error ? (
            <p className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </p>
          ) : null}
          {!state ? (
            <ScreenSkeleton />
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={screen}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={SPRING}
              >
                {screen === 'setup' ? (
                  <SetupScreen
                    state={state}
                    onRun={runJob}
                    onRefresh={refresh}
                    onDone={() => setScreen('repos')}
                  />
                ) : null}
                {screen === 'repos' ? (
                  <ReposScreen
                    state={state}
                    jobs={jobs}
                    onRun={runJob}
                    onRefresh={refresh}
                    onSelect={selectWorkspace}
                  />
                ) : null}
                {screen === 'health' ? (
                  <HealthScreen workspace={activeWorkspace} onRun={runJob} />
                ) : null}
                {screen === 'signal' ? (
                  <SignalScreen workspace={activeWorkspace} onRun={runJob} />
                ) : null}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
      <JobDock jobs={jobs} onKill={onKill} />
    </div>
  );
}
