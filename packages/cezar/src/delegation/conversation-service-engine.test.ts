import { RUN_STATUS, STEP_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runPersistence } from '../runs/run-store-open.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { fixture } from './service-engine.testkit.ts';
import { FRESH_SESSION_NOTICE } from './service.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

// Continue admission (every resume) and cancelling an open wait need the run engine.
describe('durable conversations', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => {
    for (const run of f.store.queries.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    setRunStatus(f.store, workerId, RUN_STATUS.running);
    return { id: workerId, caller: f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))! };
  }
  async function completedWorker(status: 'done' | 'review' | 'failed' | 'cancelled' = 'done', session: string | null = 'previous-session') {
    const w = await worker();
    // This service fixture holds the scheduler; remove its original queued job
    // before publishing a completed execution with a resumable provider session.
    f.manager.cancel(w.id);
    await f.manager.awaitRunTermination(w.id, 5_000);
    f.store.updateStep(w.id, 'task', { status: STEP_STATUS.done, ...(session ? { sessionId: session } : {}), backend: 'claude' });
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(w.id);
    setRunStatus(f.store, w.id, status);
    f.store.workerExecutions.commitWorkerExecutionComplete(w.id, generation);
    return w;
  }
  it.each(['done', 'review'] as const)('parent --resume atomically queues one attributed continuation of a %s worker', async status => {
    const w = await completedWorker(status);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Correct the returned result', timeoutSeconds: 600, resume: true };
    const [a, b] = await Promise.all([f.service.send(f.caller, request), f.service.send(f.caller, request)]);
    expect(b).toEqual({ ...a, effect: 'unchanged' });
    expect(a).toMatchObject({ delivery: 'queued', message: { state: 'accepted', resumed: true } });
    expect(f.store.getRun(w.id)).toMatchObject({ status: RUN_STATUS.queued, delegation: { executionRevision: 1 },
      continuationMessage: { origin: 'lifecycle', agentInputId: request.id, text: expect.stringContaining(request.text) },
      agentInputs: [{ id: request.id, conversation: { senderRunId: f.parent.id, recipientRunId: w.id } }] });
    expect(f.store.getRun(w.id)?.steps.filter(step => step.synthetic === 'continuation')).toHaveLength(1);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.continuationMessage).toEqual(f.store.getRun(w.id)?.continuationMessage);
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [a.message] } }); reopened.persistence.flush();
  });
  // hearsay-tools/squawk#3337: a cancelled worker, and one with no recorded session, restart from their worktree.
  it('parent --resume restarts a cancelled worker whose worktree and branch exist', async () => {
    const w = await completedWorker('cancelled');
    await ensureOwnedWorkspace(f.root, f.store.getRun(w.id)!);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Finish the parser change', timeoutSeconds: 600, resume: true };
    expect(await f.service.send(f.caller, request)).toMatchObject({ delivery: 'queued', message: { state: 'accepted', resumed: true } });
    expect(f.store.getRun(w.id)).toMatchObject({ status: RUN_STATUS.queued, delegation: { executionRevision: 1 },
      continuationMessage: { text: expect.not.stringContaining(FRESH_SESSION_NOTICE) } });
  });
  it('parent --resume starts a fresh session for a failed worker with no recorded session', async () => {
    const w = await completedWorker('failed', null);
    await ensureOwnedWorkspace(f.root, f.store.getRun(w.id)!);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Retry on another runner', timeoutSeconds: 600, resume: true };
    expect(await f.service.send(f.caller, request)).toMatchObject({ delivery: 'queued', message: { state: 'accepted', resumed: true } });
    expect(f.store.getRun(w.id)).toMatchObject({ status: RUN_STATUS.queued,
      continuationMessage: { text: expect.stringContaining(FRESH_SESSION_NOTICE) } });
  });
  it('returns the receipt of an exact --resume retry after the worker worktree is gone', async () => {
    const w = await completedWorker('cancelled');
    await ensureOwnedWorkspace(f.root, f.store.getRun(w.id)!);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Finish the parser change', timeoutSeconds: 600, resume: true };
    const sent = await f.service.send(f.caller, request);
    f.manager.cancel(w.id); await f.manager.awaitRunTermination(w.id, 5_000);
    const delegation = f.store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw new Error('expected a worker');
    rmSync(delegation.workspace.path, { recursive: true, force: true });
    expect(await f.service.send(f.caller, request)).toMatchObject({ effect: 'unchanged', message: { id: sent.message.id, resumed: true } });
  });
  // hearsay-tools/squawk#867: the refusal names what holds the worker and the command that gets past it.
  // ADR 0032: a process outside the worker's scope that works in its worktree is not the worker's.
  it.runIf(process.platform !== 'win32')('resumes while an outside process works in the worker worktree, and leaves that process alone', async () => {
    const w = await completedWorker('done');
    await ensureOwnedWorkspace(f.root, f.store.getRun(w.id)!);
    const delegation = f.store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw new Error('expected a worker');
    const outsider = spawn('sleep', ['60'], { cwd: delegation.workspace.path, stdio: 'ignore' });
    const exited = once(outsider, 'exit');
    try {
      const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Finish the parser change', timeoutSeconds: 600, resume: true };
      expect(await f.service.send(f.caller, request)).toMatchObject({ message: { state: 'accepted', resumed: true } });
      expect(outsider.exitCode).toBeNull();
      expect(outsider.signalCode).toBeNull();
    } finally { outsider.kill(); await exited; }
  });
  it('keeps a resumed request pending for a 45-minute reply inside its one-hour bound', async () => {
    const w = await completedWorker();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
      const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id,
        kind: 'request', text: 'Fix the review findings', resume: true, timeoutSeconds: 3600 });
      expect(sent.message.deadline).toBe('2026-10-18T11:00:00.000Z');
      expect(await f.service.send(f.caller, { id: sent.message.id, recipientRunId: w.id, kind: 'request', text: 'Fix the review findings', resume: true, timeoutSeconds: 3600 })).toEqual({ ...sent, effect: 'unchanged' });
      setRunStatus(f.store, w.id, RUN_STATUS.running);
      vi.setSystemTime(new Date('2026-10-18T10:45:00.000Z'));
      expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes).toEqual([]);
      const reply = await f.service.reply(w.caller, { id: randomUUID(), recipientRunId: f.parent.id,
        kind: 'reply', requestId: sent.message.id, text: 'Fixed', timeoutSeconds: 600 });
      expect(reply.outcome).toMatchObject({ status: 'replied', replyId: reply.message.id });
    } finally { vi.useRealTimers(); }
  });
  it('checkpoints the resumed opening input and retires its replay prompt atomically', async () => {
    const w = await completedWorker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'New instruction', timeoutSeconds: 600, resume: true };
    await f.service.send(f.caller, request);
    const before = structuredClone(f.store.getRun(w.id));
    const at = new Date().toISOString();
    const inputs = before!.agentInputs!.map(input => input.id === request.id ? { ...input, deliveredAt: at, consumedAt: at } : input);
    const fault = vi.spyOn(runPersistence(f.store), 'persist').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    expect(() => f.store.commitOutcome(w.id, { kind: 'opening-handled', inputId: request.id, at })).toThrow('disk unavailable');
    expect(f.store.getRun(w.id)).toEqual(before);
    fault.mockRestore();
    f.store.commitOutcome(w.id, { kind: 'opening-handled', inputId: request.id, at });
    expect(f.store.getRun(w.id)?.continuationMessage).toBeUndefined();
    expect(f.store.getRun(w.id)?.agentInputs).toEqual(inputs);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.continuationMessage).toBeUndefined(); reopened.persistence.flush();
  });
  it('uses the new instruction when explicitly resuming a failed continuation', async () => {
    const w = await completedWorker();
    setRunStatus(f.store, w.id, RUN_STATUS.failed, { continuationMessage: { id: 'old', text: 'Old failed prompt', origin: 'lifecycle', createdAt: new Date().toISOString() } });
    await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Correct the failed task', timeoutSeconds: 600, resume: true });
    expect(f.store.getRun(w.id)?.continuationMessage?.text).toContain('Correct the failed task');
  });
  it('accepts neither a message nor a continuation when the atomic index write fails', async () => {
    const w = await completedWorker();
    const before = structuredClone(f.store.getRun(w.id));
    vi.spyOn(runPersistence(f.store), 'persist').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Retry work', timeoutSeconds: 600, resume: true }))
      .rejects.toThrow('Worker was not resumed: the resume could not be saved (disk unavailable). No message was accepted; retry the same command');
    expect(f.store.getRun(w.id)).toEqual(before);
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
  });
  it('does not let --resume answer a human question or allow a worker to resume its parent', async () => {
    const w = await completedWorker();
    f.store.eventLog.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Approval', question: 'May I proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true })).rejects.toThrow(/human question/);
    setRunStatus(f.store, w.id, RUN_STATUS.running);
    await expect(f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('cancels an accepted worker request and its wait without granting child management', async () => {
    const w = await worker();
    const sent = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const cancelled = await f.service.cancelRequest(w.caller, { requestId: sent.message.id });
    expect(cancelled.status).toBe('cancelled');
    expect(await f.service.cancelRequest(w.caller, { requestId: sent.message.id })).toEqual(cancelled);
    // hearsay-tools/cezarion#1235: a worker's request wait is a wait-list entry.
    const waitId = randomUUID();
    f.store.commitWait(w.id, { id: waitId, kind: WAIT_KIND.worker, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'], registeredAt: new Date().toISOString(), phase: WAIT_PHASE.open, turnId: 'turn', requestIds: [sent.message.id], requestOutcomes: [], timeoutSeconds: 600, deadline: new Date(Date.now() + 600000).toISOString() });
    expect(await f.service.cancelWait(w.caller, { waitId })).toMatchObject({ wait: { id: waitId } });
    await expect(f.service.stop(w.caller, { workerId: w.id })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('checks a request-wait cancel through the parent pair even for a worker that holds wait', async () => {
    const w = await worker();
    const held = f.store.getRun(w.id)!;
    f.store.commitDelegation([{ id: w.id, delegation: { ...held.delegation, permissions: ['wait'] } as never }]);
    const sent = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const waitId = randomUUID();
    f.store.commitWait(w.id, { id: waitId, kind: WAIT_KIND.worker, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'], registeredAt: new Date().toISOString(), phase: WAIT_PHASE.open, turnId: 'turn', requestIds: [sent.message.id], requestOutcomes: [], timeoutSeconds: 600, deadline: new Date(Date.now() + 600000).toISOString() });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw new Error('fixture');
    const live = parent.delegation;
    const deletion = { phase: 'complete' as const, revision: 0, resourceId: randomUUID(), generation: randomUUID() };
    f.store.commitDelegation([{ id: parent.id, delegation: { ...live, receipts: live.receipts.map(receipt => ({ ...receipt, deletion })) } }]);
    await expect(f.service.cancelWait(w.caller, { waitId })).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
    await expect(f.service.cancelWait(w.caller, { waitId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
    f.store.commitDelegation([{ id: parent.id, delegation: { ...f.store.getRun(parent.id)!.delegation, receipts: live.receipts } as never }]);
    expect(await f.service.cancelWait(w.caller, { waitId })).toMatchObject({ wait: { id: waitId } });
  });
  it('allows a bounded day for resume requests but keeps ordinary requests bounded to two hours', async () => {
    const w = await completedWorker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Fix review', timeoutSeconds: 86400 };
    await expect(f.service.send(f.caller, request)).rejects.toThrow();
    await expect(f.service.send(f.caller, { ...request, resume: true, timeoutSeconds: 86401 })).rejects.toThrow();
    expect((await f.service.send(f.caller, { ...request, resume: true })).message.deadline).toBeDefined();
  });
  it('explains rejection with a parent-operated resume command and preserves that receipt on retry', async () => {
    const w = await completedWorker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'Correct this', timeoutSeconds: 600 };
    const rejected = await f.service.send(f.caller, request);
    expect(rejected).toMatchObject({ delivery: 'not-delivered', effect: 'refused', message: { instruction: expect.stringContaining(`worker resume ${w.id}`) } });
    expect(rejected.message.instruction).toMatch(/worker resume.*new.*ID/i);
    await expect(f.service.send(f.caller, { ...request, resume: true })).rejects.toMatchObject({ code: 'invalid_input' });
    await f.service.send(f.caller, { ...request, id: randomUUID(), resume: true });
    expect(await f.service.send(f.caller, request)).toEqual({ ...rejected, effect: 'unchanged' });
  });
});
