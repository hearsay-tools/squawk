import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { workerOperationSchema } from '@open-mercato/cezar-contract/delegation';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { askErrorMessage } from '../ci-wait/errors.ts';
import { recordedDirectory } from '../runs/shared-hosts.ts';
import { completionWorkerIds, familyWorkers, holdsCompletionGate, supervisedWorkers } from '../runs/supervised.ts';
import { runRelationships } from '../server/run-relationships.ts';
import { reconcileConversationState } from '../delegation/conversations.ts';
import { openCompletionRequests } from './completion-policy.ts';
import { settledParentRefusalError } from './continuation-admission.ts';
import { SUPERVISOR_IS_WORKER, workerQuestionRouting } from './question-routing.ts';
import { assertOwnedWorkerWaitScope, assertRequestWaitScope } from './wait-scope.ts';

// The pure rules of a family where a worker supervises a worker (hearsay-tools/squawk#3819):
// R the root, W and S its workers, C the shared worker W started.
const [R, W, S, C] = ['1', '2', '3', '4'].map(n => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string, string];
const operations = workerOperationSchema.options;
const request = (id: string, senderRunId: string, recipientRunId: string) => ({ id, senderRunId, recipientRunId, kind: 'request' as const, text: 'q',
  createdAt: '2026-11-18T12:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' as const });
const [ASKED_BY_W, ASKED_BY_R] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'] as const;
const root = (over: Partial<RunRecord> = {}): RunRecord => makeRunRecord({ id: R, title: 'root', status: RUN_STATUS.running, worktreePath: '/trees/root', delegation: { role: 'root', permissions: operations,
  receipts: [W, S].map(workerId => ({ requestId: workerId, workerId, requestHash: 'a'.repeat(64) })).concat([{ requestId: C, workerId: C, requestHash: 'a'.repeat(64), supervisorRunId: W } as never]),
  conversation: { messages: [request(ASKED_BY_W, W, C), request(ASKED_BY_R, R, W)], outcomes: [] } }, ...over });
const isolated = (id: string, over: Partial<RunRecord> = {}): RunRecord => makeRunRecord({ id, title: id, status: RUN_STATUS.running, worktreePath: `/trees/${id}`,
  delegation: { role: 'worker', permissions: operations, spawnGrant: { kinds: ['shared'], live: 1 }, parentRunId: R,
    workspace: { ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/trees/${id}`, branch: `cez/${id}`, baselineSha: 'a'.repeat(40) } }, ...over });
const child = (over: Partial<RunRecord> = {}): RunRecord => makeRunRecord({ id: C, title: 'child', status: RUN_STATUS.running,
  delegation: { role: 'worker', permissions: operations, parentRunId: R, supervisorRunId: W,
    workspace: { ownerRunId: C, resourceId: C, kind: 'shared', path: `/trees/${W}`, hostRunId: W, baselineSha: 'a'.repeat(40) } }, ...over });
const family = (...runs: RunRecord[]) => {
  const all = runs.length ? runs : [root(), isolated(W), isolated(S), child()];
  const getRun = (id: string) => all.find(run => run.id === id);
  const workers = () => all.filter(run => run.delegation?.role === 'worker');
  return { getRun, listWorkersOf: (id: string) => id === R ? workers() : [], listOwnedWorkers: (id: string) => id === R ? workers() : [], workerExecutions: { readWorkerExecution: () => undefined } };
};
const refusal = (check: () => void) => { try { check(); return undefined; } catch (error) { return (error as { code?: string }).code; } };

describe('a family where a worker supervises a worker', () => {
  it('names the family and the supervised set apart', () => {
    const store = family();
    const ids = (runs: RunRecord[]) => runs.map(run => run.id);
    expect([R, W, C].map(id => ids(familyWorkers(store, store.getRun(id))))).toEqual([[W, S, C], [W, S, C], [W, S, C]]);
    expect([R, W, S, C].map(id => ids(supervisedWorkers(store, store.getRun(id))))).toEqual([[W, S], [C], [], []]);
    // A root's completion answers for the whole family; a worker's for the workers it started.
    expect(completionWorkerIds(store, store.getRun(R)!, store.getRun(R))).toEqual([W, S, C]);
    expect(completionWorkerIds(store, store.getRun(W)!, store.getRun(R))).toEqual([C]);
    expect(completionWorkerIds(store, store.getRun(C)!, store.getRun(R))).toEqual([]);
  });

  it('lets the supervisor and the root wait on the child, and nobody else', () => {
    const { getRun } = family();
    const waits = (actor: string, target: string) => refusal(() => assertOwnedWorkerWaitScope(getRun(actor)!, [target], getRun));
    expect([[W, C], [R, C], [R, W], [S, C], [C, W], [W, S]].map(([actor, target]) => waits(actor!, target!)))
      .toEqual([undefined, undefined, undefined, 'denied_scope', 'denied_scope', 'denied_scope']);
  });

  it('lets a task that may message wait on replies to its own requests, whoever holds the ledger', () => {
    const { getRun } = family();
    const waits = (actor: RunRecord, id: string) => refusal(() => assertRequestWaitScope(actor, [id], getRun));
    expect(waits(getRun(W)!, ASKED_BY_W)).toBeUndefined();
    expect(waits(getRun(R)!, ASKED_BY_R)).toBeUndefined();
    expect(waits(getRun(C)!, ASKED_BY_W)).toBe('denied_scope');
    expect(waits(getRun(W)!, ASKED_BY_R)).toBe('denied_scope');
    // A record Squawk never writes: a root stored without the `wait` operation still waits on its replies.
    expect(waits(root({ delegation: { ...root().delegation!, permissions: ['spawn'] } as RunRecord['delegation'] }), ASKED_BY_R)).toBeUndefined();
    expect(waits(makeRunRecord({ id: W, status: RUN_STATUS.running, delegation: { role: 'invalid' } }), ASKED_BY_W)).toBe('denied_scope');
  });

  it('routes a direct worker\'s question to the root and answers a child\'s itself, with the text that names the message', () => {
    const reads = { unreadable: () => false, parentEnding: () => false };
    expect(workerQuestionRouting(isolated(W), root(), reads)).toHaveProperty('state');
    expect(workerQuestionRouting(child(), root(), reads)).toEqual({ undeliverable: SUPERVISOR_IS_WORKER });
    expect(workerQuestionRouting(child({ status: RUN_STATUS.cancelled }), root(), reads)).toEqual({ close: 'worker-stopped' });
    expect(SUPERVISOR_IS_WORKER).toContain('send the question as a request message');
    expect(askErrorMessage('supervisor_is_worker')).toMatch(/A worker started this task, so no question card reaches it\. Send your question to that worker with \w+ message request/);
  });

  it('reads a run\'s directory from its record: a shared worker\'s host path, else the worktree, else the repository root', () => {
    expect([child(), isolated(W), isolated(W, { worktreePath: undefined }), undefined].map(run => recordedDirectory(run, '/repo')))
      .toEqual([`/trees/${W}`, `/trees/${W}`, '/repo', '/repo']);
  });

  it('shows a root its whole family with each supervisor, and a worker the workers it started with its own supervisor', () => {
    const store = family();
    const forRoot = runRelationships(store, store.getRun(R)!);
    expect(forRoot.workers.map(worker => [worker.workerId, worker.parentRunId, worker.supervisorRunId])).toEqual([[W, R, undefined], [S, R, undefined], [C, R, W]]);
    expect(forRoot).toMatchObject({ capacity: { outstanding: 3, created: 3 } });
    expect(forRoot.parentRunId).toBeUndefined();
    const forWorker = runRelationships(store, store.getRun(W)!);
    expect(forWorker).toMatchObject({ parentRunId: R, workers: [{ workerId: C, supervisorRunId: W }], titles: [{ id: R, title: 'root' }, { id: C, title: 'child' }] });
    expect(forWorker.supervisorRunId).toBeUndefined(); expect(forWorker.capacity).toBeUndefined();
    expect(runRelationships(store, store.getRun(C)!)).toMatchObject({ parentRunId: R, supervisorRunId: W, workers: [], titles: [{ id: R }, { id: W }] });
    expect(runRelationships(store, store.getRun(S)!)).toEqual({ parentRunId: R, workers: [], titles: [{ id: R, title: 'root' }] });
  });

  it('settles a request by its two participants, never by the run that stores the ledger', () => {
    const now = '2026-11-18T13:00:00.000Z';
    const outcomes = (...runs: RunRecord[]) => reconcileConversationState(runs[0]!, family(...runs).getRun, now, () => true)!.outcomes.map(outcome => [outcome.requestId, outcome.status]);
    // The root has failed; W and C run on. Only the request the root sent closes.
    expect(outcomes(root({ status: RUN_STATUS.failed }), isolated(W), isolated(S), child())).toEqual([[ASKED_BY_R, 'sender-closed']]);
    // W has ended: the request it sent closes as its sender's, the one sent to it as its recipient's.
    expect(outcomes(root(), isolated(W, { status: RUN_STATUS.cancelled }), isolated(S), child())).toEqual([[ASKED_BY_W, 'sender-closed'], [ASKED_BY_R, 'cancelled']]);
    // C has ended: W's request to it settles by its recipient.
    expect(outcomes(root(), isolated(W), isolated(S), child({ status: RUN_STATUS.done }))).toEqual([[ASKED_BY_W, 'completed-without-reply']]);
    expect(outcomes(root(), isolated(W), isolated(S), child())).toEqual([]);
  });

  it('reads for a supervising worker the requests the root gate reads, and none for a worker that supervises nobody', () => {
    const store = { ...family(), listConversationRootIds: () => [], claims: { writeRefusal: () => undefined } } as never;
    const ids = (runId: string) => { const open = openCompletionRequests(store, runId); return [open.sent.map(message => message.id), open.incoming.map(message => message.id)]; };
    expect(ids(R)).toEqual([[ASKED_BY_R], []]);
    expect(ids(W)).toEqual([[ASKED_BY_W], [ASKED_BY_R]]);
    expect(ids(S)).toEqual([[], []]);
    expect(ids(C)).toEqual([[], []]);
    expect([R, W, S, C].map(id => holdsCompletionGate(family().getRun(id), family().getRun(R)))).toEqual([true, true, false, false]);
  });

  it('keeps the refusal of a Continue beside a settled root as it was', () => {
    expect(settledParentRefusalError(R, RUN_STATUS.done)).toBe(`Parent task ${R} is done; continue the parent before its worker.`);
    expect(settledParentRefusalError(R, RUN_STATUS.failed)).toBeUndefined();
  });
});
