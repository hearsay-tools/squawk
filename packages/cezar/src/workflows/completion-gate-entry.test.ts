import { testHome } from '../home/test-home.testkit.ts';
import { transitionTurnBoundary } from './run/turn-boundary.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import {
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-contract/wait-factories.testkit';
import { RunFinish } from './run/run-finish.ts';
import { TurnSettler } from './run/turn-settler.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunModuleContext } from './run/types.ts';
import { parentCompletionBlockers, type CompletionGateHost } from './run/completion-gate.ts';
import type { TurnEndOutcome } from './turn-end.ts';
import { clearIdleTimer } from './run/input-timers.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { outcomeWord } from './turn-outcomes.testkit.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';
import { unused } from './unused.testkit.ts';

// The completion gate's refusal of a live session's done outside a turn end (`settleTurn`'s `gate`
// entry, hearsay-tools/cezarion#1525). Mid-turn, the live turn end decides the refusal; at the
// boundary, owed input runs first, as at a turn end. Also the turn end's monitoring alias beside
// an ask line. The refusal through a live runner is in `completion-gate-entry-engine.test.ts`.

type State = ActiveRun;
const workerId = randomUUID();
const refusal = { code: 'workers_outstanding' as const, message: expect.stringContaining(`Workers are still live: ${workerId}.`),
  workers: [{ worker_id: workerId, reason: 'outstanding' as const }], liveWorkerIds: [workerId] };

describe('the completion gate outside a turn end', () => {
  let root: string;
  let store: RunStore;
  let finish: RunFinish;
  let settler: TurnSettler;
  let gateHost: CompletionGateHost;
  const active = new Map<string, ActiveRun>();
  const nudges = { queueCompletionRefusal: vi.fn(() => true) };
  const outcomes = vi.fn((_id: string, _entry: string, outcome: TurnEndOutcome) => outcome);
  const watchTurnOutcomes = () => ({ words: (runId: string) => outcomes.mock.calls
    .filter(([id]) => id === runId).flatMap(([, , outcome]) => outcomeWord(outcome) ?? []) });
  function fakeState() {
    const value = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    value.liveSession.attachSession(session);
    value.liveSession.selectStep('task');
    return value;
  }
  const settleBoundary = vi.fn(() => true);
  function modules() {
    const context: RunModuleContext = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work: new TrackedWork(),
      semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => false };
    gateHost = unused<CompletionGateHost>('gateHost', { active, pendingHumanAskSeq: () => undefined,
      parentCompletionBlockers: vi.fn(() => []), unansweredQuestions: () => [] });
    type SettlerArgs = ConstructorParameters<typeof TurnSettler>;
    settler = new TurnSettler(context, unused<SettlerArgs[1]>('heldDoneHost', {
      completionGate: () => 'held', settledTurnOutcome: outcomes,
      line: unused<SettlerArgs[1]['line']>('line', { inPool: () => false }),
    }), 60_000, 40, 'Wait for workers.', 3600);
    type FinishArgs = ConstructorParameters<typeof RunFinish>;
    finish = new RunFinish(context, gateHost, unused<FinishArgs[2]>('settlement'),
      unused<FinishArgs[3]>('boundarySettler', { settleTurn: settleBoundary,
        boundaryTurn: () => ({ stepId: 'task', monitoring: false, humanGate: false, ask: null, done: true, nudgedLastTurn: false }) }),
      unused<FinishArgs[4]>('nudges', nudges), unused<FinishArgs[5]>('line'), unused<FinishArgs[6]>('host'));
  }
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-gate-entry-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'gate', task: 'work', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }).id;
    setRunStatus(store, id, RUN_STATUS.running, { currentStepId: 'task' });
    store.updateStep(id, 'task', { status: STEP_STATUS.running });
    await store.transcriptFacts.factsWarmIdle();
    active.clear(); vi.clearAllMocks();
    session = {
      get open() { return true; }, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
    };
    state = fakeState();
    modules();
    active.set(id, state);
  });
  afterEach(() => { clearIdleTimer(state); vi.restoreAllMocks(); active.clear(); store.close(); rmSync(root, { recursive: true, force: true }); });

  describe('the real root gate', () => {
    beforeEach(() => {
      store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
    });

    it.each(['done', 'review', 'failed', 'cancelled'] as const)('holds a stopped root at %s without reopening it', status => {
      setRunStatus(store, id, status);
      const queue = vi.spyOn(nudges, 'queueCompletionRefusal');
      expect(finish.completionGate(id)).toBe('held');
      expect(store.getRun(id)?.status).toBe(status);
      expect(queue).not.toHaveBeenCalled();
    });

    it('retires a legacy Finish intent before refusing a live session', () => {
      store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [], finishRequestedAt: new Date().toISOString() } }]);
      vi.mocked(gateHost.parentCompletionBlockers).mockReturnValue([{ workerId, reason: 'outstanding' }]);
      expect(finish.completionGate(id)).toMatchObject({ code: 'workers_outstanding' });
      expect(store.getRun(id)?.delegation).not.toHaveProperty('finishRequestedAt');
    });

    it('queues a refusal for a closed session', () => {
      vi.spyOn(session, 'open', 'get').mockReturnValue(false);
      vi.mocked(gateHost.parentCompletionBlockers).mockReturnValue([{ workerId, reason: 'outstanding' }]);
      const queue = vi.spyOn(nudges, 'queueCompletionRefusal').mockImplementation(() => true);
      expect(finish.completionGate(id)).toBe('held');
      expect(queue).toHaveBeenCalledWith(id, expect.objectContaining({ code: 'workers_outstanding' }));
    });


  });

  // hearsay-tools/squawk#3819: the same gate holds a worker that started a worker; one that started none passes.
  describe('the gate of a worker that supervises', () => {
    const workspace = (ownerRunId: string) => ({ ownerRunId, resourceId: randomUUID(), kind: 'shared' as const, path: root, hostRunId: randomUUID(), baselineSha: 'a'.repeat(40) });
    const receipt = (ownerRunId: string, supervisorRunId?: string) => ({ requestId: randomUUID(), workerId: ownerRunId, requestHash: 'a'.repeat(64), ...(supervisorRunId ? { supervisorRunId } : {}) });
    let childId: string;
    beforeEach(() => {
      const rootId = store.createRun({ title: 'root', task: 'work', workflow: 'quick-task', steps: [] }).id;
      childId = store.createRun({ title: 'child', task: 'work', workflow: 'quick-task', steps: [] }).id;
      setRunStatus(store, rootId, RUN_STATUS.running); setRunStatus(store, childId, RUN_STATUS.running);
      store.commitDelegation([
        { id: rootId, delegation: { role: 'root', permissions: ['wait'], receipts: [receipt(id), receipt(childId, id)] } },
        { id, delegation: { role: 'worker', permissions: ['wait'], parentRunId: rootId, workspace: workspace(id) } },
        { id: childId, delegation: { role: 'worker', permissions: [], parentRunId: rootId, supervisorRunId: id, workspace: workspace(childId) } },
      ]);
      vi.mocked(gateHost.parentCompletionBlockers).mockImplementation(runId => parentCompletionBlockers({ store } as RunModuleContext, gateHost, runId));
    });

    it('refuses the supervisor\'s done while its child is live, and names the child and the wait', () => {
      expect(finish.completionGate(id)).toMatchObject({ code: 'workers_outstanding', liveWorkerIds: [childId],
        message: expect.stringContaining(`Workers are still live: ${childId}. Wait for them (\`worker wait ${childId}\`, then end your turn)`) });
      expect(finish.completionGate(childId)).toBe('accept');
    });

    it('refuses the supervisor\'s done while a request it sent is open, as the root gate does', () => {
      const rootId = store.getRun(id)!.delegation!.role === 'worker' ? (store.getRun(id)!.delegation as { parentRunId: string }).parentRunId : '';
      const request = { id: randomUUID(), senderRunId: id, recipientRunId: childId, kind: 'request' as const, text: 'q', createdAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
      store.commitConversation(rootId, { messages: [request], outcomes: [] });
      vi.mocked(gateHost.parentCompletionBlockers).mockReturnValue([]);
      expect(finish.completionGate(id)).toMatchObject({ code: 'requests_outstanding', requestIds: [request.id] });
      store.commitConversation(rootId, { messages: [request], outcomes: [{ requestId: request.id, status: requestOutcomeSchema.shape.status.enum.cancelled, observedAt: new Date().toISOString() }] });
      expect(finish.completionGate(id)).toBe('accept');
    });

    it('names a worker that another worker started among the root\'s live blockers, the set its completion wait takes', () => {
      const rootId = (store.getRun(id)!.delegation as { parentRunId: string }).parentRunId;
      expect(finish.completionRefusal(rootId)).toMatchObject({ code: 'workers_outstanding', liveWorkerIds: expect.arrayContaining([childId]) });
    });
  });

  const queueInput = () => store.commitAgentInputs(id, [{ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]);
  const openWorkerWait = () => store.commitWait(id, { kind: WAIT_KIND.worker, id: randomUUID(), source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, phase: WAIT_PHASE.open, turnId: 'turn', mode: 'all',
    workerIds: [workerId], revisions: [], outcomes: [] });
  const sent = () => vi.mocked(session.sendMessage).mock.calls.length + vi.mocked(session.sendAgentMessage).mock.calls.length;
  /** A root whose live worker blocks its done: the real gate refuses it to the open session. */
  const blockedRoot = () => {
    store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
    vi.mocked(gateHost.parentCompletionBlockers).mockReturnValue([{ workerId, reason: 'outstanding' }]);
  };

  it.each([['queued input', queueInput], ['an open agent wait', openWorkerWait]])('mid-turn, %s leaves the refusal to the live turn end', (_name, setup) => {
    blockedRoot();
    setup();
    expect(finish.deferParentCompletion(id)).toBe(true);
    expect(store.getRun(id)?.status).toBe('running');
    expect(sent()).toBe(0);
    expect(settleBoundary).not.toHaveBeenCalled();
  });

  it.each([['queued input', queueInput], ['an open agent wait', openWorkerWait]])(
    'at the boundary, %s delegates the refusal to turn settlement', (_name, setup) => {
      transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session: session });
      blockedRoot();
      setup();
      expect(finish.deferParentCompletion(id)).toBe(true);
      expect(settleBoundary).toHaveBeenCalledExactlyOnceWith(id, state, 'gate',
        expect.objectContaining({ done: true }), refusal);
      expect(nudges.queueCompletionRefusal).not.toHaveBeenCalled();
    });

  // The gate held the done itself (a stopped root, or a question that parked for the user): a turn
  // end keeps the done at the boundary and settles the park; an acknowledgement settles the park
  // only.
  describe('a done the gate holds', () => {
    const turnEnd = () => settler.settleTurn(id, state, 'turn-end', { stepId: 'task', monitoring: false, humanGate: false,
      ask: null, done: true, nudgedLastTurn: false });
    const ack = () => settler.settleTurn(id, state, 'ack', settler.boundaryTurn(id, state, session, true));
    beforeEach(() => {
      transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session: session });
      state.inputState.beginHeldClock();
    });

    it('a turn end keeps the done at the boundary, resets the held-input clock and settles the park', () => {
      const turns = watchTurnOutcomes();
      expect(turnEnd()).toBe(true);
      expect(state.boundary.doneAtBoundary).toBe(session);
      expect(state.boundary.doneClose).toEqual({ via: 'cezar_done' });
      expect(state.inputState.heldHumanInputSince).toBeUndefined();
      expect(turns.words(id)).toEqual(['waiting']);
    });

    it('a turn end whose input checkpoint failed settles nothing', () => {
      const turns = watchTurnOutcomes();
      state.inputState.recordInputError('agent input delivery checkpoint failed');
      expect(turnEnd()).toBe(false);
      expect(state.boundary.doneAtBoundary).toBe(session);
      expect(turns.words(id)).toEqual([]);
    });

    it('an acknowledgement settles the park and leaves the boundary and the held-input clock as they were', () => {
      const turns = watchTurnOutcomes();
      transitionTurnBoundary(state, { kind: 'turn-end', phase: 'retain-done', session: session });
      expect(ack()).toBe(true);
      expect(state.boundary.doneAtBoundary).toBe(session);
      expect(state.inputState.heldHumanInputSince).toBeDefined();
      expect(turns.words(id)).toEqual(['waiting']);
    });
  });
});
