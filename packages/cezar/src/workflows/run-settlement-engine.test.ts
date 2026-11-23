import { testHome } from '../home/test-home.testkit.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, fixtureWorkSettled } from './fixture-manager.testkit.ts';
import { seedSettlementRun } from './run-settlement.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import type { AgentSession, AgentRunResult } from '../core/agent-runner.ts';
import type { RunManager } from './run.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE, makeTimerWait } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import { worktreeDiff } from '../git-worktree.ts';

vi.mock('../git-worktree.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../git-worktree.ts')>(),
  worktreeDiff: vi.fn(async () => 'a changed file'),
}));

/** Success settlement through the public manager: completion deferral, usage-limit holds and
 *  disposal cross RunFinish, the session and the manager. `run-settlement.test.ts` covers what
 *  RunSettlement alone does to the steps. */
describe('successful run settlement on the engine', () => {
  let root: string;
  let store: RunStore;
  const f = setupMonitoringFixture();
  let manager: RunManager;
  let settle: (id: string, durable?: boolean) => Promise<void>;

  beforeEach(() => {
    root = f.repoRoot;
    store = f.store;
    manager = f.manager;
    runnerHook.runner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession: () => ({ open: false, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false, sendAgentMessage: () => false, end: () => {}, interrupt: () => {},
        discardQueuedMessages: () => {}, holdsHumanInput: () => false }),
    };
    settle = async (id, durable) => {
      if (durable) expect(manager.finish(id)).toBe(true);
      else expect(manager.continueRun(id, { text: 'complete', runner: 'claude' })).toMatchObject({ ok: true });
      await fixtureWorkSettled(root);
    };
    vi.mocked(worktreeDiff).mockResolvedValue('a changed file');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const seed = (durable: boolean) => seedSettlementRun(store, root, durable);

  it.each(['before diff', 'during diff'])('parent attention deferral %s leaves live steps untouched', async timing => {
    const id = seed(true);
    const steps = structuredClone(store.getRun(id)!.steps);
    const ask = () => store.eventLog.appendEvent(id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    const family = () => store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [{ requestId: randomUUID(), workerId: randomUUID(), requestHash: 'b'.repeat(64) }] } }]);
    if (timing === 'before diff') ask();
    // The question holds completion only for a root with workers (hearsay-tools/cezarion#2784).
    else vi.mocked(worktreeDiff).mockImplementationOnce(async () => { family(); ask(); return 'changed'; });
    if (timing === 'before diff') { family(); expect(manager.finish(id)).toBe(false); }
    else await settle(id, true);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.finishedAt).toBeUndefined();
    expect(store.getRun(id)?.steps).toEqual(steps);
  });

  async function usageLimitFailure(late: boolean) {
    manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    manager = createFixtureManager(store, root, { home: testHome(), semaphore });
    f.manager = manager;
    let fail!: (error: Error) => void;
    let finish!: (result: AgentRunResult) => void;
    const tools = vi.spyOn(manager, 'squawkToolHandlers');
    let started = false;
    const startSession = vi.fn<NonNullable<typeof runnerHook.runner>['startSession']>((_spec, onEvent) => {
      const session: AgentSession = { open: true, result: new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
        sendMessage: () => true, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => finish({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: () => finish({ text: '', toolCalls: [], tokensUsed: 0 }) };
      started = true;
      queueMicrotask(() => onEvent?.({ type: 'session', sessionId: 'limited', resumed: false }));
      return session;
    });
    runnerHook.runner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {}, startSession };
    const record = manager.startRun(f.SINGLE_STEP, { task: 'wait', runner: 'claude', worktree: false });
    f.currentId = record.id;
    await waitForProduct(manager, store, () => started);
    const handlers = tools.mock.results.find(result => result.type === 'return')!.value;
    expect((await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 3600 }, 'cezar_wait', new AbortController().signal)).answer.ok).toBe(true);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    store.commitAgentInputs(record.id, [{ id: randomUUID(), parentRunId: record.id, source: 'lifecycle',
      text: 'pending', createdAt: new Date().toISOString() }]);
    let raced = false;
    let heldSnapshot: ReturnType<RunStore['getRun']>;
    const lateWait = makeTimerWait({ id: randomUUID(), registeredAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 3_600_000).toISOString() });
    const commitLateWait = ({ runId, event }: { runId: string; event: { type: string; message?: string } }) => {
      if (!late || runId !== record.id || event.type !== 'lifecycle' || !event.message?.startsWith('usage limit reached') || raced) return;
      raced = true;
      store.commitWait(record.id, lateWait);
      heldSnapshot = structuredClone(store.getRun(record.id));
    };
    const stopCommitLateWait = store.lifecycle.subscribe({ 'run.event': commitLateWait });
    const releaseSlot = semaphore.release.bind(semaphore);
    const release = vi.spyOn(semaphore, 'release').mockImplementation(() => {
      expect(store.getRun(record.id)?.autoResumeAt).toEqual(expect.any(String));
      return releaseSlot();
    });
    try {
      fail(new Error(`Claude AI usage limit reached|${reset}`));
      await waitForProduct(manager, store, () => !!store.getRun(record.id)?.autoResumeAt && !manager.isActive(record.id));
      await fixtureWorkSettled(root);
      expect(raced).toBe(late);
      // The hold is the failure's own write (hearsay-tools/squawk#3337): a wait committed as it lands
      // stays open on the held run, and the retry delivers it (hold.wait-resolves).
      if (late) {
        expect(heldSnapshot).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: expect.any(String),
          waits: expect.arrayContaining([expect.objectContaining({ id: lateWait.id, phase: WAIT_PHASE.open })]) });
        expect(store.getRun(record.id)?.waits).toContainEqual(expect.objectContaining({ id: lateWait.id, phase: WAIT_PHASE.open }));
      }
      expect(startSession).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalled();
      expect(store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: expect.any(String) });
      expect(store.eventLog.readEvents(record.id).filter(event => String(event.message).includes('continu'))).toEqual([]);
    } finally {
      stopCommitLateWait();
    }

  }

  it('publishes a usage-limit resume before releasing a failed run', () => usageLimitFailure(false));
  it('a timer wait committed as the run holds stays open without queuing a wake', () => usageLimitFailure(true));

  it.each(['finish', 'cancel'] as const)('public %s survives disposal during success diff I/O', async intent => {
    const id = seed(true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      if (intent === 'cancel') {
        expect(manager.cancel(id)).toBe(true);
        expect(store.getRun(id)?.status).toBe(RUN_STATUS.cancelled);
      }
      manager.dispose();
      return 'changed';
    });
    await settle(id, true);
    const completed = store.getRun(id)!;
    expect(completed.status).toBe(intent === 'cancel' ? RUN_STATUS.cancelled : RUN_STATUS.done);
    expect(completed.finishedAt).toBeDefined();
    expect(completed.steps.some(step => step.status === 'running' || step.status === 'waiting')).toBe(false);
  });
});
