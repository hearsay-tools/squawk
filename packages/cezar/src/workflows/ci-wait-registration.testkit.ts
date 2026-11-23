import '../built-in-wait-kinds.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi, type Mock } from 'vitest';
import type { CiWait, CiWaitResult } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND } from '@open-mercato/cezar-contract/wait-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { SquawkWaitRequestInput } from '@open-mercato/cezar-contract/wait-tools';
import type { SquawkToolHandlers } from '../ci-wait/controller.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { canProceedWithRun, executionBlockedByRootFinish, workerExecutionStopped } from './run/run-guards.ts';
import { squawkToolHandlers, type ToolHost } from './run/squawk-tools.ts';
import type { RunModuleContext } from './run/types.ts';
import { automaticWakes } from './run/wake-ledger.ts';
import { WaitEngine } from './run/wait-engine.ts';
import { WaitRegistry } from './run/wait-registry.ts';
import { unused } from './unused.testkit.ts';
// Its stores reach worker executions: the shipped ones (hearsay-tools/squawk#4039).
import '../delegation/worker-executions.testkit.ts';

// `WaitRegistry` and `WaitEngine` over a real store, with no run engine: the registration policy,
// the wait list and its receipts are theirs. The registry host reads the run guards the run
// manager reads; the engine host keeps only what opening, arming and resolving a wait asks.

type EngineHost = ConstructorParameters<typeof WaitEngine>[1];
type RegistryHost = ConstructorParameters<typeof WaitRegistry>[1];
type Supervisor = ReturnType<RegistryHost['ciSupervisor']>;

export const GENERATION = 'generation';
const MAX_AUTO_CONTINUES = 40;
export const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
export const identityOf = (url: string) => ({ prUrl: url, repository: 'acme/repo', prNumber: Number(url.split('/').pop()), headSha: 'a'.repeat(40) });
export const success = (): CiWaitResult => ({ outcome: 'passed', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: true });

export interface FakeGithub {
  supervisor: { resolve: Mock<Supervisor['resolve']>; watch: Mock<Supervisor['watch']>; close: Mock<() => void> };
  settle(n: number): void;
  aborted(n: number): boolean | undefined;
}

/** External GitHub per PR number: each lookup answers its URL's identity, each watch settles on its own. */
function githubByPr(): FakeGithub {
  const watches = new Map<number, { settle(result: CiWaitResult): void; signal: AbortSignal }>();
  const supervisor = {
    resolve: vi.fn<Supervisor['resolve']>(async url => identityOf(url)),
    watch: vi.fn<Supervisor['watch']>((wait: CiWait, signal: AbortSignal) => new Promise<CiWaitResult>(resolve => { watches.set(wait.prNumber, { settle: resolve, signal }); })),
    close: vi.fn<() => void>(),
  };
  return { supervisor, settle: (n: number) => watches.get(n)!.settle(success()), aborted: (n: number) => watches.get(n)?.signal.aborted };
}

/** The registry and engine one run manager would hold over `store`, with these active runs. */
function modules(store: RunStore, root: string, active: Map<string, ActiveRun>, supervisor: Supervisor, semaphore: WorkspaceSemaphore, disposed: () => boolean) {
  const context = unused<RunModuleContext>('context', { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), semaphore, disposed });
  const stopped = (id: string) => workerExecutionStopped(store, id, () => false);
  const countAutomaticWakes = (id: string) => automaticWakes(store, active, id);
  let registry!: WaitRegistry;
  const engineHost = unused<EngineHost>('engine host', {
    active: id => active.get(id), ciSupervisor: () => supervisor, countAutomaticWakes,
    canProceedWithRun: (id, run): run is NonNullable<typeof run> => canProceedWithRun(run, () => stopped(id), value => executionBlockedByRootFinish(store, value)),
    withdrawSquawkHumanWaits: vi.fn(), isParked: () => false, queueWaitWake: vi.fn(),
    abortRegistrations: id => registry.abortRegistrations(id),
  });
  const engine = new WaitEngine(context, engineHost, MAX_AUTO_CONTINUES);
  registry = new WaitRegistry(context, unused<RegistryHost>('registry host', {
    waitEngine: engine, active: id => active.get(id), ciSupervisor: () => supervisor, countAutomaticWakes,
    workerExecutionStopped: stopped, executionBlockedByRootFinish: run => executionBlockedByRootFinish(store, run),
  }), MAX_AUTO_CONTINUES);
  const toolHost = unused<ToolHost>('tool host', { store,
    registerWait: (...args) => registry.registerWait(...args), cancelWait: (...args) => registry.cancelWait(...args) });
  return { engine, registry, tools: (runId: string, generation = GENERATION) => squawkToolHandlers(runId, generation, toolHost),
    close: () => { registry.dispose(); engine.disposeWatches(); engine.disposeRetries(); engine.dispose(); } };
}

export interface WaitRegistryFixture {
  root: string;
  run: RunRecord;
  state: ActiveRun;
  /** The session's `open` flag: set it false to close the session. */
  session: { open: boolean };
  active: Map<string, ActiveRun>;
  github: FakeGithub;
  readonly store: RunStore;
  readonly engine: WaitEngine;
  readonly registry: WaitRegistry;
  tools(runId?: string, generation?: string): SquawkToolHandlers;
  registerPr(n: number, timeout?: number): ReturnType<WaitRegistry['registerWait']>;
  registerTimer(seconds?: number, note?: string): ReturnType<WaitRegistry['registerWait']>;
  waitById(waitId: string): Wait | undefined;
  /** What `RunManager.dispose` does to registration: the context reads disposed and in-flight lookups abort. */
  dispose(): void;
  /** Reopen the store from disk with no active run, as after a restart. */
  restart(): void;
}

/** A root run with an open session at its CI generation, its registry and engine, and the tool
 *  handlers over them. */
export function waitRegistryFixture(): WaitRegistryFixture {
  const root = mkdtempSync(join(tmpdir(), 'cez-wait-registry-'));
  let store = RunStore.open(join(root, '.ai/cezar'));
  const run = store.createRun({ title: 'registration', task: 'guard', workflow: 'quick-task', steps: [] });
  setRunStatus(store, run.id, RUN_STATUS.running);
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
  const session = { open: true };
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  state.liveSession.attachSession(unused<AgentSession>('session', session));
  state.liveSession.beginCiGeneration(GENERATION);
  state.waitIdentity.rotateCiTurn('turn');
  const active = new Map([[run.id, state]]);
  const github = githubByPr();
  const semaphore = unused<WorkspaceSemaphore>('semaphore', { monitoringWakeIntervalMinutes: () => 5 });
  let disposed = false;
  let current = modules(store, root, active, github.supervisor, semaphore, () => disposed);
  onTestFinished(() => { current.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, run, state, session, active, github,
    get store() { return store; }, get engine() { return current.engine; },
    get registry() { return current.registry; }, tools: (runId = run.id, generation?: string) => current.tools(runId, generation),
    registerPr: (n: number, timeout = 30) => current.registry.registerWait(run.id, { kind: WAIT_KIND.pr, pr: prUrl(n), timeout_seconds: timeout }, 'cezar_wait', GENERATION),
    registerTimer: (seconds = 60, note?: string) => current.registry.registerWait(run.id, { kind: WAIT_KIND.timer, seconds, ...(note === undefined ? {} : { note }) } satisfies SquawkWaitRequestInput, 'cezar_wait', GENERATION),
    waitById: (waitId: string) => store.getRun(run.id)?.waits?.find(entry => entry.id === waitId),
    dispose: () => { disposed = true; current.registry.dispose(); },
    restart: () => {
      current.close(); store.close();
      store = RunStore.open(join(root, '.ai/cezar'));
      active.clear();
      current = modules(store, root, active, github.supervisor, semaphore, () => disposed);
    },
  };
}
