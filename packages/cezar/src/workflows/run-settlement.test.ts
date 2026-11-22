import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { unused } from './unused.testkit.ts';
import { liveStatuses, oldFinish, preservedStatuses, seedSettlementRun } from './run-settlement.testkit.ts';
import { RUN_STATUS, STEP_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type StepState } from '../runs/store.ts';
import { worktreeDiff } from '../git-worktree.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';
registerRunner(claudeRunner);

vi.mock('../git-worktree.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../git-worktree.ts')>(),
  worktreeDiff: vi.fn(async () => 'a changed file'),
}));

/** What RunSettlement.settleSuccess does to a run's steps around its diff I/O. Paths that need the
 *  manager (Finish deferral, usage-limit holds, disposal) are in `run-settlement-engine.test.ts`. */
describe('successful run settlement (#473)', () => {
  let root: string;
  let store: RunStore;
  let settle: (id: string, durable?: boolean) => Promise<void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-settlement-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    settle = (id, durable) => policy(new Map(), false, true).settleSuccess(id, durable);
    vi.mocked(worktreeDiff).mockResolvedValue('a changed file');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
  });

  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const seed = (durable = false) => seedSettlementRun(store, root, durable);

  for (const durable of [false, true]) {
    for (const status of ['done', 'review'] as const) {
      it(`${durable ? 'durable root' : 'ordinary'} ${status} closes only live steps and preserves timestamps`, async () => {
        vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
        vi.useFakeTimers({ toFake: ['Date'] });
        const id = seed(durable);
        const untouched = structuredClone(store.getRun(id)!.steps.filter(step => preservedStatuses.includes(step.status as typeof preservedStatuses[number])));
        const terminalSnapshots: StepState[][] = [];
        onRunWrite(store.lifecycle, record => {
          if (record.id === id && record.status === status) terminalSnapshots.push(structuredClone(record.steps));
        });
        await settle(id, durable);
        store.flush();
        const completed = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }).getRun(id)!;
        expect(completed.status).toBe(status);
        expect(completed.currentStepId).toBeUndefined();
        expect(completed.steps.filter(step => preservedStatuses.some(preserved => step.id.startsWith(preserved)))).toEqual(untouched);
        for (const live of liveStatuses) {
          expect(completed.steps.find(step => step.id === `${live}-false`)).toMatchObject({ status: STEP_STATUS.done, finishedAt: completed.finishedAt, startedAt: oldFinish });
          expect(completed.steps.find(step => step.id === `${live}-true`)).toMatchObject({ status: STEP_STATUS.done, finishedAt: oldFinish, startedAt: oldFinish });
        }
        expect(terminalSnapshots.length).toBeGreaterThan(0);
        expect(terminalSnapshots.flat().some(step => step.status === 'waiting' || step.status === 'running')).toBe(false);
      });
    }

    it.each(['cancelled', 'failed'] as const)(`${durable ? 'durable root' : 'ordinary'} settlement preserves %s during diff I/O`, async status => {
      const id = seed(durable);
      let release!: (diff: string) => void;
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      vi.mocked(worktreeDiff).mockImplementationOnce(() => new Promise(resolve => { release = resolve; enter(); }));
      const pending = settle(id, durable);
      await entered;
      setRunStatus(store, id, status, { finishedAt: oldFinish });
      const snapshot = structuredClone(store.getRun(id));
      release('changed');
      await pending;
      expect(store.getRun(id)).toEqual(snapshot);
      expect(store.readEvents(id).some(event => event.type === 'lifecycle' && event.message === 'run finished')).toBe(false);
    });
  }

  it('uses current step statuses after diff I/O, retaining a concurrent failure', async () => {
    const id = seed();
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      store.updateStep(id, 'waiting-false', { status: STEP_STATUS.failed, error: 'late failure', finishedAt: oldFinish });
      store.addStep(id, { id: 'late-step', name: 'Late step', kind: STEP_KIND.agent, synthetic: 'continuation' });
      store.updateStep(id, 'late-step', { status: STEP_STATUS.running });
      return 'changed';
    });
    await settle(id);
    expect(store.getRun(id)?.steps.find(step => step.id === 'waiting-false')).toMatchObject({ status: STEP_STATUS.failed, error: 'late failure', finishedAt: oldFinish });
    expect(store.getRun(id)?.steps.find(step => step.id === 'late-step')).toMatchObject({ status: STEP_STATUS.done, finishedAt: store.getRun(id)?.finishedAt });
  });

  function fakeState(finishRequested = false, cancelled = false) {
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    if (finishRequested) state.liveSession.requestFinish();
    if (cancelled) state.liveSession.cancel();
    return state;
  }

  function policy(active: Map<string, ActiveRun>, disposed: boolean | (() => boolean), asyncSuccess = false) {
    type Args = ConstructorParameters<typeof RunSettlement>;
    return new RunSettlement({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => typeof disposed === 'function' ? disposed() : disposed },
      unused<Args[1]>('humanWaits'), unused<Args[2]>('workerQuestions'), unused<Args[3]>('autosave', asyncSuccess ? { autosaveCleanupBlocker: () => undefined } : {}),
      unused<Args[4]>('line'), unused<Args[5]>('resume'),
      unused<Args[6]>('workers'), unused<Args[7]>('completionGate'),
      unused<Args[8]>('host', { active, generation: () => undefined,
        ...(asyncSuccess ? { deferParentCompletion: () => false } : {}) }), '', '');
  }

  it.each([false, true])('does not reconcile a replacement execution during diff I/O (disposed=%s)', async disposed => {
    const id = seed();
    const original = fakeState(true);
    const active = new Map([[id, original]]);
    let detached = false;
    const settlement = policy(active, () => detached, true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      detached = disposed;
      active.set(id, fakeState());
      return 'changed';
    });
    const before = structuredClone(store.getRun(id)!);
    await settlement.settleSuccess(id);
    expect(store.getRun(id)?.status).toBe(before.status);
    expect(store.getRun(id)?.finishedAt).toBe(before.finishedAt);
    expect(store.getRun(id)?.steps).toEqual(before.steps);
  });

  it('disposal without terminal intent leaves the row unchanged after diff I/O', async () => {
    const id = seed();
    const active = new Map([[id, fakeState()]]);
    let disposed = false;
    const settlement = policy(active, () => disposed, true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      disposed = true;
      active.clear();
      return 'changed';
    });
    const before = structuredClone(store.getRun(id)!);
    await settlement.settleSuccess(id);
    expect(store.getRun(id)?.status).toBe(before.status);
    expect(store.getRun(id)?.finishedAt).toBe(before.finishedAt);
    expect(store.getRun(id)?.steps).toEqual(before.steps);
  });

  it.each(['none', 'finish', 'cancel'] as const)('disposal during diff I/O preserves explicit terminal intent: %s', intent => {
    const original = fakeState(intent === 'finish', intent === 'cancel');
    expect(policy(new Map(), true).successSuperseded('run', RUN_STATUS.waiting, original, undefined)).toBe(intent === 'none');
  });
});
