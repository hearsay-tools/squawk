import { spawnCapacityRefusal } from '../../delegation/capacity.ts';
import '../../core/created-runners.testkit.ts';
import { registerRunner } from '../../core/runner-registry.ts';
import { claudeRunner } from '../../runners/claude/definition.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_VIA, makeTimerWait } from '@open-mercato/cezar-contract/wait-factories.testkit';
import type { AgentInput } from '@open-mercato/cezar-contract/agent-input';
import { RunStore } from '../../runs/store.ts';
import type { RunEventInput } from '../../runs/ports.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../fixture-no-runner.testkit.ts';
import type { RunManager } from '../run.ts';
import { AUTONOMOUS_NO_ACK_NOTE, AUTONOMOUS_NO_REPLY_NOTE, AUTONOMOUS_NUDGE, COMPLETION_NUDGE_NOTE, NO_WAIT_NO_REPLY_NOTE, NO_WAIT_NUDGE_NOTE } from '../turn-end.ts';
import { COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES } from './constants.ts';
import { QUICK_TASK_WORKFLOW } from '../types.ts';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { completionRefusalQueueDecision } from './turn-nudges.ts';
import * as activeRuns from '../active-run.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from '../run-fixture.testkit.ts';
import { createFixtureManager as createRunnerFixtureManager } from '../fixture-manager.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../../runners/claude/spec-support.ts';
import type { AgentEvent, AgentRunResult, AgentSession } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
registerRunner(claudeRunner);

describe('completionRefusalQueueDecision', () => {
  it.each([
    { held: true, owed: true, spent: 40, decision: 'held', trace: ['held'] },
    { held: false, owed: true, spent: 40, decision: 'owed', trace: ['held', 'owed'] },
    { held: false, owed: false, spent: 40, decision: 'budget', trace: ['held', 'owed', 'count'] },
    { held: false, owed: false, spent: 41, decision: 'budget', trace: ['held', 'owed', 'count'] },
    { held: false, owed: false, spent: 39, decision: 'enqueue', trace: ['held', 'owed', 'count'] },
  ])('returns $decision with lazy ordered reads: $held/$owed/$spent', row => {
    const trace: string[] = [];
    const read = (name: string, value: boolean | number, id: string) => { expect(id).toBe('run'); trace.push(name); return value; };
    const decision = completionRefusalQueueDecision('run', {
      holdsAgentWaits: id => !!read('held', row.held, id),
      owesCompletionRefusal: id => !!read('owed', row.owed, id),
      countAutomaticWakes: id => Number(read('count', row.spent, id)),
    }, 40);
    expect(decision).toBe(row.decision);
    expect(trace).toEqual(row.trace);
  });
});

describe('closed-session refusal effects through public recovery', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let workerId: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-refusal-decision-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    const parent = store.createRun({ title: 'legacy parent', task: 'history', workflow: 'quick-task',
      workflowDef: QUICK_TASK_WORKFLOW, runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    id = parent.id;
    store.updateStep(id, 'task', { status: STEP_STATUS.waiting, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(store, id, RUN_STATUS.waiting, { automaticWakes: 7, delegation: { role: 'root', permissions: [], receipts: [] } });
    workerId = randomUUID();
    store.createOwnedRun({ title: 'live worker', task: 'history', workflow: 'quick-task', steps: [] }, id, randomUUID(), {
      role: 'worker', parentRunId: id, permissions: [], workspace: { ownerRunId: workerId, resourceId: randomUUID(),
        kind: 'owned-isolated', path: join(root, 'worker'), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40) },
    }, 'a'.repeat(64), spawnCapacityRefusal);
    store.commitRootFinishIntent(id);
    // Recovery must reach the gate, while owned capacity prevents later continuation launches.
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
    manager = createFixtureManager(store, root, { home: testHome(), semaphore });
    vi.stubEnv('CEZ_AUTONAME', '0');
  });
  afterEach(async () => {
    manager.dispose();
    await drainFixtureManagers(root);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  function refusalInput(): AgentInput {
    return { id: randomUUID(), parentRunId: id, source: 'lifecycle', purpose: 'completion-refusal',
      text: `Workers are still live: ${workerId}. ${COMPLETION_WILL_WAIT}`, createdAt: new Date().toISOString() };
  }

  function observeGate(expected: string[], beforeEvent?: (event: RunEventInput) => void) {
    const trace: string[] = [];
    let inGate = false;
    let checked = false;
    const append = store.eventLog.appendEvent.bind(store.eventLog), move = store.move.bind(store), flush = store.persistence.flush.bind(store.persistence);
    vi.spyOn(store.eventLog, 'appendEvent').mockImplementation((runId, event) => {
      if (runId === id && event.type === 'note' && String(event.message).startsWith('Completion blocked:')) {
        inGate = true; trace.push('warning');
      } else if (runId === id && inGate) {
        beforeEvent?.(event);
        trace.push(`event:${event.type}`);
      }
      return append(runId, event);
    });
    vi.spyOn(store, 'move').mockImplementation((...args) => {
      if (args[0] === id && inGate) trace.push(args[1]);
      return move(...args);
    });
    vi.spyOn(store.persistence, 'flush').mockImplementation(() => { if (inGate) trace.push('flush'); return flush(); });
    // The gate is synchronous. Recovery next enumerates runs after its live-run loop,
    // before rearmRecoveredWakes. Check the complete trace at that owned store boundary.
    const list = store.queries.listRuns.bind(store.queries);
    vi.spyOn(store.queries, 'listRuns').mockImplementation((...args) => {
      if (inGate) {
        expect(trace).toEqual(expected);
        checked = true;
        inGate = false;
      }
      return list(...args);
    });
    const retry = observationClock(delay => {
      if (delay !== 1000 || !/\bat WakeRetries\.retryWaitAdmission \(/.test(new Error().stack ?? '')) return false;
      if (inGate) trace.push('retry');
      return true;
    });
    return { trace, retry, inGate: () => inGate, checked: () => checked };
  }

  it('keeps the exact owed input and charge through the gate, then rearms its wake', async () => {
    const input = refusalInput();
    store.commitAgentInputs(id, [input]);
    const expected = ['warning', 'park', 'flush'];
    const gate = observeGate(expected);
    const outcome = vi.spyOn(store, 'commitOutcome');
    const wait = vi.spyOn(store, 'commitWait');
    const inputs = vi.spyOn(store, 'commitAgentInputs');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(1);
    expect(gate.retry.pending).toBe(1);
    expect(store.getRun(id)?.agentInputs).toEqual([input]);
    expect(store.getRun(id)?.automaticWakes).toBe(7);
    expect(store.getRun(id)?.delegation).not.toHaveProperty('finishRequestedAt');
    expect(fixtureWork(manager).liveSessions.size).toBe(0);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(wait.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(inputs.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.eventLog.readEvents(id).filter(event => event.type === 'agent-input' || String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toEqual([]);
  });

  it('commits the budget alias before surfacing its note, with no refusal charge', async () => {
    store.updateRun(id, { automaticWakes: MAX_AUTO_CONTINUES });
    const expected = ['warning', 'park', 'flush', 'alias', 'event:note', 'surfaced'];
    let aliasId: string | undefined;
    const gate = observeGate(expected, event => {
      if (event.type !== 'note' || !String(event.message).includes('automatic-wake budget spent')) return;
      expect(aliasId).toBeDefined();
      expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: aliasId, via: WAIT_VIA.budget })]);
      expect(gate.trace).toEqual(['warning', 'park', 'flush', 'alias']);
    });
    const commit = store.commitWait.bind(store);
    vi.spyOn(store, 'commitWait').mockImplementation((...args) => {
      if (args[0] === id && gate.inGate()) {
        if (args[1].kind !== 'human' || args[1].askSeq === undefined) {
          expect(gate.trace).toEqual(['warning', 'park', 'flush']);
          gate.trace.push('alias');
          aliasId = args[1].id;
        } else {
          expect(gate.trace).toEqual(['warning', 'park', 'flush', 'alias', 'event:note']);
          expect(args[1].id).toBe(aliasId);
          expect(args[1].askSeq).toBe(store.eventLog.readEvents(id).at(-1)?.seq);
          gate.trace.push('surfaced');
        }
      }
      return commit(...args);
    });
    const outcome = vi.spyOn(store, 'commitOutcome');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(0);
    expect(store.getRun(id)?.agentInputs ?? []).toEqual([]);
    expect(store.getRun(id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
    expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: aliasId, askSeq: expect.any(Number) })]);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.eventLog.readEvents(id).filter(event => String(event.message).includes('automatic-wake budget spent'))).toHaveLength(1);
  });

  it.each([false, true])('enqueues with an atomic charge, persistence failure=%s', async failure => {
    const expected = failure ? ['warning', 'park', 'flush', 'charge']
      : ['warning', 'park', 'flush', 'charge', 'event:agent-input', 'event:note'];
    const gate = observeGate(expected);
    const commit = store.commitOutcome.bind(store);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'commitOutcome').mockImplementation((...args) => {
      if (args[0] !== id || !gate.inGate()) return commit(...args);
      expect(gate.trace).toEqual(['warning', 'park', 'flush']);
      gate.trace.push('charge');
      expect(args[1]).toEqual({ kind: 'charged', automaticWakes: 8 });
      expect(args[2]?.enqueue).toEqual([expect.objectContaining({ purpose: 'completion-refusal', parentRunId: id })]);
      if (failure) throw Error('owned outcome checkpoint failure');
      const committed = commit(...args);
      expect(store.getRun(id)?.agentInputs).toEqual(args[2]?.enqueue);
      expect(store.getRun(id)?.automaticWakes).toBe(8);
      return committed;
    });
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(failure ? 0 : 1);
    if (failure) {
      expect(gate.trace).toEqual(['warning', 'park', 'flush', 'charge']);
      expect(store.getRun(id)?.agentInputs ?? []).toEqual([]);
      expect(store.getRun(id)?.automaticWakes).toBe(7);
      expect(console.warn).toHaveBeenCalledWith(`[hsq] completion refusal not queued: owned outcome checkpoint failure`);
    } else {
      expect(store.getRun(id)?.agentInputs).toEqual([expect.objectContaining({ text: expect.stringContaining(`Workers are still live: ${workerId}.`), purpose: 'completion-refusal' })]);
      expect(store.getRun(id)?.automaticWakes).toBe(8);
      expect(store.getRun(id)?.agentInputs?.[0]?.text.endsWith(COMPLETION_WILL_WAIT)).toBe(true);
    }
  });

  it('keeps an agent wait ahead of an owed refusal without a new charge or wake', async () => {
    const input = refusalInput();
    store.commitAgentInputs(id, [input]);
    store.commitWait(id, makeTimerWait({ deadline: new Date(Date.now() + 60_000).toISOString() }));
    const expected = ['warning', 'park', 'flush'];
    const gate = observeGate(expected);
    const outcome = vi.spyOn(store, 'commitOutcome');
    const wait = vi.spyOn(store, 'commitWait');
    const inputs = vi.spyOn(store, 'commitAgentInputs');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(1);
    expect(gate.retry.pending).toBe(1);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(wait.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(inputs.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.getRun(id)?.agentInputs).toEqual([input]);
    expect(store.getRun(id)?.automaticWakes).toBe(7);
  });
});

// hearsay-tools/squawk#2443: a submitted autonomous nudge whose acknowledgement never arrives is
// bounded as the no-wait nudge's reply is. Its expiry notes the nudge and closes through the idle path.
describe('the acknowledgement bound of a submitted autonomous nudge', () => {
  const f = setupMonitoringFixture();
  const BOUND_MS = 300;
  let session: AgentSession | undefined;
  let emit: (event: AgentEvent) => void;
  let emitUi: (event: UiEvent) => void;
  let acknowledge: () => void;
  /** A native heartbeat frame and a usage update: transport activity that is not model work. */
  let heartbeat: () => void;
  /** OpenCode emits the nudge's turn.started inside sendAgentMessage, before it returns. */
  let startsTurnOnSend: boolean;

  beforeEach(() => {
    session = undefined;
    startsTurnOnSend = false;
    f.manager.dispose();
    f.manager = createRunnerFixtureManager(f.store, f.repoRoot, { home: testHome(), noWaitNudgeReplyMs: BOUND_MS });
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        emit = event => onEvent?.(event);
        emitUi = event => options?.onUiEvent?.(event);
        heartbeat = () => { options?.onActivity?.(); emitUi({ type: 'usage.updated', usage: { input: 1, output: 1, total: 2 } }); };
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        // The nudge's acknowledgement settles only when the test acknowledges it.
        const sendAgentMessage = vi.fn(() => {
          if (startsTurnOnSend) emitUi({ type: 'turn.started', turnId: randomUUID() });
          return new Promise<void>(resolve => { acknowledge = resolve; });
        });
        session = { get open() { return open; }, result, sendMessage: vi.fn(() => true), sendAgentMessage,
          end: vi.fn(close), interrupt: vi.fn(close), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
        queueMicrotask(() => emit({ type: 'session', sessionId: 'ack-bound-session', resumed: false }));
        return session;
      },
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function startNudged() {
    const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', autonomous: true, worktree: false });
    f.currentId = record.id;
    await waitForProduct(f.manager, f.store, () => !!session);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    if (!session) throw new Error('runner session missing');
    emit({ type: 'turn-end' });
    expect(session.sendAgentMessage).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    expect(f.store.getRun(record.id)?.status).toBe(RUN_STATUS.running);
    return { id: record.id, session };
  }
  const boundNotes = (id: string) => f.store.eventLog.readEvents(id).filter(e => e.type === 'note' && e.message === AUTONOMOUS_NO_ACK_NOTE);

  async function expectClosedWaiting(id: string, nudged: AgentSession): Promise<void> {
    expect(nudged.end).toHaveBeenCalledOnce();
    expect(boundNotes(id)).toHaveLength(1);
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.waiting);
    expect(f.store.getRun(id)?.steps.at(-1)?.status).toBe(STEP_STATUS.waiting);
    // The idle path opens no Needs You.
    expect(f.store.getRun(id)?.waits ?? []).toEqual([]);
  }

  it('closes a run whose nudge gets no acknowledgement and no reply through the idle path', async () => {
    const { id, session: nudged } = await startNudged();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    expect(nudged.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expectClosedWaiting(id, nudged);
  });

  // hearsay-tools/squawk#3741: an ACK means the transport took the nudge, not that a turn started.
  const answerNotes = (id: string) => f.store.eventLog.readEvents(id).filter(e => e.type === 'note' && e.message === AUTONOMOUS_NO_REPLY_NOTE);

  it('an acknowledged nudge that gets no turn closes the run after the answer bound, heartbeats or not', async () => {
    const { id, session: nudged } = await startNudged();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    acknowledge();
    await vi.advanceTimersByTimeAsync(0);
    for (let tick = 0; tick < 4; tick++) {
      await vi.advanceTimersByTimeAsync(BOUND_MS / 4 - 1);
      heartbeat();
    }
    expect(nudged.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4);
    expect(nudged.end).toHaveBeenCalledOnce();
    expect(answerNotes(id)).toHaveLength(1);
    expect(boundNotes(id)).toEqual([]);
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.waiting);
    expect(f.store.getRun(id)?.steps.at(-1)?.status).toBe(STEP_STATUS.waiting);
    expect(f.store.getRun(id)?.waits ?? []).toEqual([]);
  });

  it('a turn start the send emits is no answer: the acknowledged nudge still closes the run after the bound', async () => {
    startsTurnOnSend = true;
    const { id, session: nudged } = await startNudged();
    acknowledge();
    await vi.advanceTimersByTimeAsync(0);
    heartbeat();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    expect(nudged.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(nudged.end).toHaveBeenCalledOnce();
    expect(answerNotes(id)).toHaveLength(1);
  });

  it('a turn start after the acknowledgement cancels the answer bound', async () => {
    const { id, session: nudged } = await startNudged();
    acknowledge();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    emitUi({ type: 'turn.started', turnId: randomUUID() });
    await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(answerNotes(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
  });

  it('model work after the acknowledgement cancels the answer bound', async () => {
    const { id, session: nudged } = await startNudged();
    acknowledge();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    emit({ type: 'text', text: 'answering the nudge' });
    await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(answerNotes(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
  });

  it('an acknowledgement that arrives while the nudge\'s turn already works arms no answer bound', async () => {
    startsTurnOnSend = true;
    const { id, session: nudged } = await startNudged();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    emit({ type: 'tool-call', id: randomUUID(), tool: 'Bash', input: {} });
    acknowledge();
    await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(answerNotes(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
  });

  it('a nudge whose send starts its turn at once keeps its bound off while the turn works', async () => {
    startsTurnOnSend = true;
    const { id, session: nudged } = await startNudged();
    for (let tick = 0; tick < 3; tick++) {
      await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
      emit({ type: 'text', text: `still working ${tick}` });
    }
    expect(nudged.end).not.toHaveBeenCalled();
    expect(boundNotes(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
    emit({ type: 'turn-end' });
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await expectClosedWaiting(id, nudged);
  });

  it('model work with no turn start stops the bound, as the no-progress guard counts it', async () => {
    const { id, session: nudged } = await startNudged();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    emit({ type: 'tool-call', id: randomUUID(), tool: 'Read', input: {} });
    await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(boundNotes(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
    // The run tracks the nudge's delivery until it settles; teardown needs it settled.
    acknowledge();
  });

  it('an image from the agent stream is model work that stops the bound', async () => {
    const { id, session: nudged } = await startNudged();
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    emit({ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    await vi.advanceTimersByTimeAsync(BOUND_MS * 2);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(boundNotes(id)).toEqual([]);
    acknowledge();
  });

  it('a retired session\'s late model work does not stop the current session\'s bound', async () => {
    const { id, session: retired } = await startNudged();
    const retiredEmit = emit;
    const retiredEmitUi = emitUi;
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await expectClosedWaiting(id, retired);
    vi.useRealTimers();
    expect(f.manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
    await waitForProduct(f.manager, f.store, () => !!session && session !== retired && f.store.getRun(id)?.status === RUN_STATUS.running);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const current = session!;
    emit({ type: 'turn-end' });
    expect(current.sendAgentMessage).toHaveBeenCalledOnce();
    retiredEmit({ type: 'text', text: 'late text from the retired session' });
    retiredEmitUi({ type: 'turn.started', turnId: randomUUID() });
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    expect(current.end).toHaveBeenCalledOnce();
    expect(boundNotes(id)).toHaveLength(2);
  });

  it('a reply inside the bound cancels it; its turn end, still unacknowledged, bounds the nudge again', async () => {
    const { id, session: nudged } = await startNudged();
    emitUi({ type: 'turn.started', turnId: randomUUID() });
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    expect(nudged.end).not.toHaveBeenCalled();
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
    emit({ type: 'turn-end' });
    expect(nudged.sendAgentMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await expectClosedWaiting(id, nudged);
  });
});

// hearsay-tools/squawk#3740: StepLoop keeps one ActiveRun across workflow steps, so a late reply
// from an earlier step's session reaches the same run state. It must not clear the reply bound of
// the current step's no-wait nudge. The events go through the runner's own event callbacks.
describe('the no-wait nudge reply bound across workflow steps', () => {
  const f = setupMonitoringFixture();
  const BOUND_MS = 300;
  const TWO_STEPS = { name: 'two-steps', source: 'built-in' as const, steps: [{ id: 'first', name: 'First', prompt: '{{task}}' }, { id: 'second', name: 'Second', prompt: '{{task}}' }] };
  type Wire = { session: AgentSession; emit: (event: AgentEvent) => void; emitUi: (event: UiEvent) => void; close: () => void };
  let wires: Wire[];

  let states: activeRuns.ActiveRun[];

  beforeEach(() => {
    wires = [];
    states = [];
    const create = activeRuns.createActiveRun;
    vi.spyOn(activeRuns, 'createActiveRun').mockImplementation(init => { const state = create(init); states.push(state); return state; });
    f.manager.dispose();
    f.manager = createRunnerFixtureManager(f.store, f.repoRoot, { home: testHome(), noWaitNudgeReplyMs: BOUND_MS });
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        const session: AgentSession = { get open() { return open; }, result, sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
          end: vi.fn(close), interrupt: vi.fn(close), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
        const emit = (event: AgentEvent) => onEvent?.(event);
        wires.push({ session, emit, emitUi: event => options?.onUiEvent?.(event), close });
        queueMicrotask(() => emit({ type: 'session', sessionId: `step-${wires.length}`, resumed: false }));
        return session;
      },
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Close the first step's session, open the second step's, and nudge it at a turn end with no wait. */
  async function secondStepNudged() {
    const record = f.manager.startRun(TWO_STEPS, { task: 'work', runner: 'claude', worktree: false });
    f.currentId = record.id;
    await waitForProduct(f.manager, f.store, () => wires.length === 1);
    const first = wires[0]!;
    // The done tool's completion mark lets the first step hand over to the second.
    const state = states.at(-1)!;
    transitionTurnBoundary(state, { kind: 'done-step-consumed', phase: 'completed', session: state.liveSession.session, stepId: 'first' });
    first.close();
    await waitForProduct(f.manager, f.store, () => wires.length === 2);
    const second = wires[1]!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    second.emit({ type: 'turn-end' });
    expect(second.session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(f.store.eventLog.readEvents(record.id).filter(e => e.type === 'note' && String(e.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(1);
    return { id: record.id, first, second };
  }
  const unanswered = (id: string) => f.store.eventLog.readEvents(id).filter(e => e.type === 'note' && e.message === NO_WAIT_NO_REPLY_NOTE);

  it('a late reply from the first step\'s session leaves the second step\'s bound armed', async () => {
    const { id, first } = await secondStepNudged();
    first.emit({ type: 'text', text: 'late text from the first step' });
    first.emit({ type: 'tool-call', id: randomUUID(), tool: 'Read', input: {} });
    first.emitUi({ type: 'turn.started', turnId: randomUUID() });
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    expect(unanswered(id)).toHaveLength(1);
  });

  it('a reply from the second step\'s session still clears its bound', async () => {
    const { id, second } = await secondStepNudged();
    second.emit({ type: 'text', text: 'reply from the second step' });
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    expect(unanswered(id)).toEqual([]);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
  });
});
