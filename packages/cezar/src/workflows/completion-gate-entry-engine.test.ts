import { testHome } from '../home/test-home.testkit.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-manager.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import type { AgentEvent, AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { RUN_STATUS, STEP_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { DONE_RECONSIDERED_NOTE } from './turn-end.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The completion gate's refusal of a done reached through a live runner: queued input, an open wait
// and a question after the done, on the real engine. The gate and settle decisions themselves are
// module tests in `completion-gate-entry.test.ts`.
describe('completion refusal through a live runner', () => {
  const f = setupMonitoringFixture();
  let session: AgentSession;
  let emit: (event: AgentEvent) => void;
  let ready: () => void;
  let emitUi: (event: import('../core/ui-events.ts').UiEvent) => void;
  let semaphore: WorkspaceSemaphore;
  let handlers: ReturnType<typeof f.manager.squawkToolHandlers>;
  let started: boolean;
  beforeEach(() => {
    started = false;
    f.manager.dispose();
    semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } });
    f.manager = createFixtureManager(f.store, f.repoRoot, { home: testHome(), semaphore });
    const tools = vi.spyOn(f.manager, 'squawkToolHandlers');
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        emit = event => onEvent?.(event);
        ready = () => options?.onAgentInputReady?.();
        emitUi = event => options?.onUiEvent?.(event);
        session = { get open() { return open; }, result, sendMessage: vi.fn(() => true),
          sendAgentMessage: vi.fn(async () => {}), end: vi.fn(close), interrupt: vi.fn(close),
          discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
        started = true;
        handlers = tools.mock.results.find(result => result.type === 'return')!.value;
        queueMicrotask(() => emit({ type: 'session', sessionId: 'gate-session', resumed: false }));
        return session;
      },
    };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function start() {
    const run = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
    f.currentId = run.id;
    await waitForProduct(f.manager, f.store, () => started);
    f.store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
    return run.id;
  }
  function blockCompletion(id: string) {
    const peer = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', steps: [] });
    f.store.commitConversation(id, { messages: [{ id: randomUUID(), senderRunId: id, recipientRunId: peer.id,
      kind: 'request', relationship: 'peer', text: 'Check', createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 600_000).toISOString(), state: 'accepted', requestHash: 'a'.repeat(64),
    }], outcomes: [] });
  }

  it('delivers queued input before parking a refused done', async () => {
    const id = await start();
    expect(await handlers.finishTurn({}, new AbortController().signal)).toMatchObject({ ok: true });
    blockCompletion(id);
    const inputId = randomUUID();
    f.store.commitAgentInputs(id, [{ id: inputId, parentRunId: randomUUID(), source: agentInputSchema.shape.source.enum.agent,
      text: 'Read this first', createdAt: new Date().toISOString() }]);
    emit({ type: 'turn-end' });
    await waitForProduct(f.manager, f.store, () => !!f.store.getRun(id)?.agentInputs?.find(input => input.id === inputId)?.deliveredAt);
    // The parent's instruction also withdraws the done (hearsay-tools/squawk#2587), and says so.
    expect(session.sendAgentMessage).toHaveBeenCalledWith([{ type: 'text', text: expect.stringContaining('Read this first') },
      { type: 'text', text: `\n\n${DONE_RECONSIDERED_NOTE}` }], [inputId]);
    expect(f.store.getRun(id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(1);
  });

  it('parks an open wait once when completion is refused again at readiness', async () => {
    const id = await start();
    expect((await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 3600 }, 'cezar_wait', new AbortController().signal)).answer.ok).toBe(true);
    expect(await handlers.finishTurn({}, new AbortController().signal)).toMatchObject({ ok: true });
    blockCompletion(id);
    const release = vi.spyOn(semaphore, 'release');
    emit({ type: 'turn-end' });
    await waitForProduct(f.manager, f.store, () => f.store.getRun(id)?.status === 'waiting');
    expect(f.store.getRun(id)?.steps.find(step => step.id === 'task')?.status).toBe('waiting');
    expect(semaphore.busy()).toBe(0);
    const releases = release.mock.calls.length;
    expect(releases).toBe(1);
    ready();
    expect(release).toHaveBeenCalledTimes(releases);
    expect(f.store.getRun(id)?.status).toBe('waiting');
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  // A question after the done withdraws it (hearsay-tools/squawk#2587): the run parks on the question.
  it('parks the step and releases capacity for a question asked after the done', async () => {
    const id = await start();
    expect(await handlers.finishTurn({}, new AbortController().signal)).toMatchObject({ ok: true });
    // The question holds completion only for a root with workers (hearsay-tools/cezarion#2784).
    f.store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [{ requestId: randomUUID(), workerId: randomUUID(), requestHash: 'b'.repeat(64) }] } }]);
    emitUi({ type: 'ask.requested', requestId: randomUUID(), context: 'Choose a path.',
      questions: [{ header: 'Choice', question: 'Which path?' }] });
    await f.store.factsWarmIdle();
    const releaseSlot = semaphore.release.bind(semaphore);
    const release = vi.spyOn(semaphore, 'release').mockImplementation(() => {
      expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.waiting);
      expect(f.store.getRun(id)?.steps.find(step => step.id === 'task')?.status).toBe(STEP_STATUS.waiting);
      return releaseSlot();
    });
    emit({ type: 'turn-end' });
    await waitForProduct(f.manager, f.store, () => f.store.getRun(id)?.status === 'waiting');
    expect(f.store.getRun(id)?.steps.find(step => step.id === 'task')?.status).toBe('waiting');
    expect(semaphore.busy()).toBe(0);
    expect(release).toHaveBeenCalledOnce();
    expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'note', message: 'cezar_done withdrawn: the agent asked the user',
    })]));
    expect(f.store.getRun(id)?.doneAccepted).toBeUndefined();
  });
});
