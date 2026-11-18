import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-registry.ts';
import '../core/every-runner.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { supervisedReceipts } from '../runs/task-rights.ts';
import { parentReadiness } from './readiness.ts';
import { ownLimitRefusal, workerCapacity } from './capacity.ts';
import type { Caller } from './credentials.ts';
import { NO_SPAWN_GRANT, WORKERS_OFF } from './policy.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture, workerCleanupInternals } from './service.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';

// A worker that supervises (hearsay-tools/squawk#3819): R is the root task, W the worker R
// started in its own worktree, C the shared worker W started.
let f: ReturnType<typeof fixture>;
const sessions: Array<{ spec: AgentRunSpec; finish(): void; fail(): void }> = [];
let onSession: (cwd: string) => void = () => {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
const run = (id: string) => f.store.getRun(id)!;
const callerOf = (runId: string): Caller => f.credentials.authenticate(f.credentials.issue('project', runId, randomUUID()))!;
const plain = () => ({ task: 'review the change', requestId: randomUUID() });
const denied = { code: 'denied_scope', message: 'Worker scope denied' };
const waitsOf = (id: string) => [...run(id).waits ?? [], ...run(id).lastWaits ?? []];
const receiptsOfRoot = () => { const root = run(f.parent.id).delegation; return root?.role === 'root' ? root.receipts : []; };

/** R starts W in its own worktree and W's session opens; `w` is W's authenticated caller. */
async function supervisor(): Promise<{ id: string; w: Caller; directory: string; fail(): void }> {
  const { workerId } = await f.service.spawn(f.caller, { task: 'supervise', baseline: 'parent-head', requestId: randomUUID() });
  const before = sessions.length;
  await f.releaseAdmission();
  await until(() => sessions.length > before);
  const session = sessions.at(-1)!;
  return { id: workerId, w: callerOf(workerId), directory: realpathSync(run(workerId).worktreePath!), fail: () => session.fail() };
}
/** W starts C with a plain spawn and C's session opens. */
async function child(w: Caller, act: (cwd: string) => void = () => {}): Promise<{ id: string; c: Caller; finish(): Promise<void> }> {
  const before = sessions.length;
  onSession = act;
  const { workerId } = await f.service.spawn(w, plain());
  await until(() => sessions.length > before);
  const session = sessions.at(-1)!;
  return { id: workerId, c: callerOf(workerId), finish: async () => { session.finish(); expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true); } };
}

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  onTestFinished(scopeFixtureProcesses());
  sessions.length = 0; onSession = () => {};
  f = fixture(workerCleanups());
  vi.spyOn(runners, 'createRunner').mockImplementation(async backend => ({
    backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: spec => {
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<AgentRunResult>((done, failed) => { resolve = done; reject = failed; });
      const finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      onSession(spec.cwd);
      sessions.push({ spec, finish, fail: () => { open = false; reject(new Error('the runner crashed')); } });
      return { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
    },
  }));
});
afterEach(async () => {
  for (const session of sessions) session.finish();
  try { await f.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe('a worker that supervises a worker (hearsay-tools/squawk#3819)', { timeout: 90_000 }, () => {
  it('spawns one live shared worker, waits for it and reads its result without the root', async () => {
    const W = await supervisor();
    expect(run(W.id).delegation).toMatchObject({ permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], spawnGrant: { kinds: ['shared'], live: 1 } });
    const C = await child(W.w, cwd => writeFileSync(join(cwd, 'review.txt'), 'the finding\n'));

    // The receipt is the root's; the supervisor is the worker; the directory is the worker's worktree.
    expect(receiptsOfRoot().map(receipt => [receipt.workerId, receipt.supervisorRunId])).toEqual([[W.id, undefined], [C.id, W.id]]);
    const record = run(C.id).delegation;
    expect(record).toMatchObject({ role: 'worker', parentRunId: f.parent.id, supervisorRunId: W.id,
      workspace: { kind: 'shared', hostRunId: W.id, path: W.directory, baselineSha: git(W.directory, 'rev-parse', 'HEAD') } });
    expect(record?.role === 'worker' && record.spawnGrant).toBeUndefined();
    expect(sessions.at(-1)!.spec.cwd).toBe(W.directory);

    // The child's own spawn, a second child and an isolated child are refused, each with its reason.
    await expect(f.service.spawn(C.c, plain())).rejects.toMatchObject({ code: 'denied_scope', message: NO_SPAWN_GRANT });
    await expect(f.service.spawn(W.w, plain())).rejects.toMatchObject({ code: 'capacity_limit', message: ownLimitRefusal(1, 1) });
    await expect(f.service.spawn(W.w, { ...plain(), workspace: 'isolated', baseline: 'parent-head' }))
      .rejects.toMatchObject({ code: 'denied_scope', message: 'This task cannot spawn a worker with --workspace isolated. Allowed: --workspace shared' });

    // The worker waits; the child's settlement resolves the worker's wait and gives the root nothing.
    const { wait } = await f.service.wait(W.w, { workerIds: [C.id], timeoutSeconds: 600 });
    await C.finish();
    await until(() => waitsOf(W.id).some(entry => entry.id === wait.id && entry.phase !== 'open'));
    expect(waitsOf(W.id).find(entry => entry.id === wait.id)).toMatchObject({ kind: WAIT_KIND.worker, result: { reason: 'outcome' }, outcomes: [{ workerId: C.id }] });
    expect(waitsOf(f.parent.id)).toEqual([]);
    expect(run(f.parent.id).agentInputs ?? []).toEqual([]);

    // The result is kept on the root's record and names what changed in the shared directory.
    const result = await f.service.collect(W.w, { workerId: C.id });
    expect(result).toMatchObject({ workerId: C.id, parentRunId: f.parent.id, settled: true,
      workspace: { kind: 'shared', path: W.directory }, changes: { state: 'changed', paths: ['review.txt'] } });
    expect(f.store.readWorkerResult(f.parent.id, C.id)).toMatchObject({ workerId: C.id, revision: result.revision });
    expect(await f.service.collect(f.caller, { workerId: C.id })).toMatchObject({ workerId: C.id, changes: { state: 'changed' } });

    // Each lists what it may inspect; the root's entry names the supervisor.
    expect((await f.service.list(W.w)).workers.map(entry => entry.workerId)).toEqual([C.id]);
    expect((await f.service.list(f.caller)).workers.map(entry => [entry.workerId, entry.supervisorRunId])).toEqual([[W.id, undefined], [C.id, W.id]]);
    expect(await f.service.inspect(f.caller, { workerId: C.id })).toMatchObject({ parentRunId: f.parent.id, supervisorRunId: W.id });
    await expect(f.service.steer(f.caller, { workerId: C.id }, { text: 'not yours' })).rejects.toMatchObject(denied);
    await expect(f.service.diff(f.caller, { workerId: C.id })).rejects.toMatchObject(denied);
    await expect(f.service.inspect(C.c, { workerId: W.id })).rejects.toMatchObject(denied);

    // Destroy frees the worker's one slot; the family count holds every receipt.
    expect(await f.service.destroy(W.w, { workerId: C.id })).toMatchObject({ state: 'complete', remaining: [] });
    expect(workerCapacity(run(f.parent.id), id => f.store.getRun(id))).toMatchObject({ outstanding: 1, created: 2 });
    const next = await child(W.w);
    expect(supervisedReceipts(run(f.parent.id), W.id).map(receipt => receipt.workerId)).toEqual([C.id, next.id]);
  });

  it('scopes a request ID to its supervisor, counts the child in the family limit and obeys the root\'s workers switch', async () => {
    const W = await supervisor();
    const request = plain();
    const first = await f.service.spawn(W.w, request);
    expect(await f.service.spawn(W.w, request)).toEqual(first);
    await expect(f.service.spawn(W.w, { ...request, task: 'another task' })).rejects.toMatchObject({ code: 'invalid_input', message: 'Request ID payload conflict' });
    const rootsOwn = await f.service.spawn(f.caller, { ...request, workspace: 'shared' });
    expect(rootsOwn.workerId).not.toBe(first.workerId);
    expect(run(rootsOwn.workerId).delegation).toMatchObject({ workspace: { hostRunId: f.parent.id } });

    for (let n = receiptsOfRoot().length; n < 32; n++) await f.service.spawn(f.caller, { ...plain(), workspace: 'shared' });
    expect(workerCapacity(run(f.parent.id), id => f.store.getRun(id))).toMatchObject({ outstanding: 32, created: 32 });
    expect(await f.service.destroy(W.w, { workerId: first.workerId })).toMatchObject({ state: 'complete' });
    setRunStatus(f.store, f.parent.id, RUN_STATUS.running, { allowWorkers: false });
    await expect(f.service.spawn(W.w, plain())).rejects.toMatchObject({ code: 'incompatible_state', message: WORKERS_OFF });
    setRunStatus(f.store, f.parent.id, RUN_STATUS.running, { allowWorkers: true });
    expect((await f.service.spawn(W.w, plain())).workerId).toEqual(expect.any(String));
    await expect(f.service.spawn(f.caller, { ...plain(), workspace: 'shared' })).rejects.toMatchObject({ code: 'capacity_limit', message: expect.stringContaining('Parent has 32 outstanding workers') });
  });

  it('carries messages both ways between the worker and its child in the root\'s ledger, and none between the root and the child', async () => {
    const W = await supervisor();
    const C = await child(W.w);
    const [question, followUp, answer] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await f.service.send(W.w, { id: question, recipientRunId: C.id, kind: 'request', text: 'what did you find?', timeoutSeconds: 600 })).toMatchObject({ message: { state: 'accepted' } });
    const { wait } = await f.service.waitRequests(W.w, { requestIds: [question], timeoutSeconds: 600 });
    await f.service.followUp(W.w, { id: followUp, recipientRunId: C.id, kind: 'follow-up', requestId: question, text: 'the short form', timeoutSeconds: 600 });
    await f.service.reply(C.c, { id: answer, recipientRunId: W.id, kind: 'reply', requestId: question, text: 'one finding', timeoutSeconds: 600 });
    const ledger = run(f.parent.id).delegation;
    expect(ledger?.role === 'root' && ledger.conversation?.messages.map(message => [message.id, message.senderRunId, message.recipientRunId]))
      .toEqual([[question, W.id, C.id], [followUp, W.id, C.id], [answer, C.id, W.id]]);
    expect((await f.service.conversation(C.c, { recipientRunId: W.id })).outcomes).toMatchObject([{ requestId: question, status: 'replied', replyId: answer }]);
    await until(() => waitsOf(W.id).some(entry => entry.id === wait.id && entry.phase !== 'open'));

    const open = randomUUID();
    await f.service.send(W.w, { id: open, recipientRunId: C.id, kind: 'request', text: 'one more', timeoutSeconds: 600 });
    const second = await f.service.waitRequests(W.w, { requestIds: [open], timeoutSeconds: 600 });
    expect((await f.service.cancelWait(W.w, { waitId: second.wait.id })).wait).toMatchObject({ id: second.wait.id, reason: 'cancelled' });

    for (const [caller, recipientRunId] of [[f.caller, C.id], [C.c, f.parent.id]] as const) {
      await expect(f.service.send(caller, { id: randomUUID(), recipientRunId, kind: 'progress', text: 'no line', timeoutSeconds: 600 })).rejects.toMatchObject(denied);
      await expect(f.service.conversation(caller, { recipientRunId })).rejects.toMatchObject(denied);
    }
  });

  it('holds the worker\'s completion while its child is live or uncollected', async () => {
    const W = await supervisor();
    const C = await child(W.w);
    const blockers = () => {
      const ids = supervisedReceipts(run(f.parent.id), W.id).map(receipt => receipt.workerId);
      return parentReadiness(run(W.id), f.parent.id, ids.map(workerId => ({ workerId, run: f.store.getRun(workerId),
        terminated: f.store.readWorkerExecution(workerId)?.phase === 'complete', result: f.store.readWorkerResult(f.parent.id, workerId) })));
    };
    expect(blockers()).toEqual([{ workerId: C.id, reason: 'outstanding' }]);
    await C.finish();
    expect(blockers()).toEqual([{ workerId: C.id, reason: 'uncollected' }]);
    await f.service.collect(W.w, { workerId: C.id });
    expect(blockers()).toEqual([]);
  });

  it.each(['cancelled', 'failed'] as const)('cancels the live child of a worker that is %s, and leaves a settled one collectable by the root', async ending => {
    const W = await supervisor();
    const settled = await child(W.w);
    await settled.finish();
    await f.service.destroy(W.w, { workerId: settled.id });
    const kept = await child(W.w);
    await kept.finish();
    await f.service.collect(W.w, { workerId: kept.id });
    await f.service.destroy(W.w, { workerId: kept.id });
    const live = await child(W.w);
    if (ending === 'cancelled') f.manager.cancel(W.id);
    else W.fail();
    await until(() => run(W.id).status === ending && run(live.id).status === RUN_STATUS.cancelled);
    expect(await f.service.collect(f.caller, { workerId: kept.id })).toMatchObject({ workerId: kept.id, cleanup: 'complete' });
    expect(await f.service.stop(f.caller, { workerId: live.id })).toMatchObject({ workerId: live.id });
  });

  it('keeps the family\'s live workers when the root fails, and their requests to each other open', async () => {
    const W = await supervisor();
    const C = await child(W.w);
    setRunStatus(f.store, f.parent.id, RUN_STATUS.failed);
    f.manager.reconcileWorkerWaits(f.parent.id);
    expect([W.id, C.id].map(id => run(id).status)).toEqual([RUN_STATUS.running, RUN_STATUS.running]);
    // The failed root only stores the ledger: a request between the two live workers stays open, and its reply resolves it.
    const [question, answer] = [randomUUID(), randomUUID()];
    expect(await f.service.send(W.w, { id: question, recipientRunId: C.id, kind: 'request', text: 'still there?', timeoutSeconds: 600 })).toMatchObject({ message: { state: 'accepted' } });
    f.manager.reconcileWorkerWaits(f.parent.id);
    expect((await f.service.conversation(W.w, { recipientRunId: C.id })).outcomes).toEqual([]);
    expect(await f.service.reply(C.c, { id: answer, recipientRunId: W.id, kind: 'reply', requestId: question, text: 'yes', timeoutSeconds: 600 }))
      .toMatchObject({ outcome: { requestId: question, status: 'replied', replyId: answer } });
  });

  // Lock order (worker-cleanup.ts): a scheduled tick takes its worker's key, then the project's
  // `destroy-retries` key. A supervisor's tick that then waited for its child's key would wait on
  // the child's tick, which holds that key and waits for the project key.
  it('finishes a supervisor retry and a child retry that run at the same time', { timeout: 30_000 }, async () => {
    const W = await supervisor();
    const C = await child(W.w);
    const cleanup = [...workerCleanupInternals(f.service)][0]!;
    const project = (Reflect.get(f.service, 'projects') as Map<string, Parameters<typeof cleanup.destroyAttempt>[0]>).get('project')!;
    const tick = (id: string) => (Reflect.get(cleanup, 'destroyTick') as (project: unknown, workerId: string) => Promise<void>).call(cleanup, project, id);
    const destroyOf = (id: string) => { const record = run(id).delegation; return record?.role === 'worker' ? record.destroy : undefined; };
    // Both destroys are pending, as after a restart during an incomplete cleanup.
    for (const [id, remaining] of [[W.id, ['process', 'worktree', 'branch']], [C.id, ['process']]] as const) {
      f.store.commitDelegation([{ id, delegation: { ...run(id).delegation!, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: [...remaining] } } as never }]);
    }
    await Promise.all([tick(W.id), tick(C.id)]);
    expect(destroyOf(C.id)).toMatchObject({ phase: 'complete', remaining: [] });
    // The supervisor's attempt did not wait for the child: it reported itself incomplete and retries.
    expect(destroyOf(W.id)).toMatchObject({ phase: 'incomplete', error: `Worker ${C.id}, which this worker started, is not destroyed yet: its cleanup retries on its own` });
    await tick(W.id);
    expect(destroyOf(W.id)).toMatchObject({ phase: 'complete', remaining: [] });
  });

  it('records the destroy of a child that has none when the supervisor\'s retry runs first', async () => {
    const W = await supervisor();
    const C = await child(W.w);
    const cleanup = [...workerCleanupInternals(f.service)][0]!;
    const project = (Reflect.get(f.service, 'projects') as Map<string, Parameters<typeof cleanup.destroyAttempt>[0]>).get('project')!;
    expect(await cleanup.destroyAttempt(project, W.id, () => f.store.getRun(W.id)!, 'scheduled')).toMatchObject({ state: 'incomplete' });
    const requested = run(C.id).delegation;
    expect(requested?.role === 'worker' && requested.destroy).toMatchObject({ phase: 'requested', remaining: ['process'] });
  });

  it('destroys the child before the worker, and deletes the worker\'s history only after the child\'s', async () => {
    const W = await supervisor();
    const C = await child(W.w);
    const order: string[] = [];
    for (const cleanup of workerCleanupInternals(f.service)) {
      const original = cleanup.destroyAttempt.bind(cleanup);
      cleanup.destroyAttempt = async (...args) => { const result = await original(...args); order.push(args[1]); return result; };
    }
    expect(await f.service.destroy(f.caller, { workerId: W.id })).toMatchObject({ state: 'complete', remaining: [] });
    expect(order).toEqual([C.id, W.id]);
    expect([C.id, W.id].map(id => { const record = run(id).delegation; return record?.role === 'worker' && record.destroy?.phase; })).toEqual(['complete', 'complete']);
    expect(f.store.canDeleteRun(W.id)).toBe(false);
    expect(f.store.deleteRun(C.id)).toBe(true);
    expect(f.store.canDeleteRun(W.id)).toBe(true);
  });
});
