import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSendRequest } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { fixture } from './service-engine.testkit.ts';

// Messages between root tasks (hearsay-tools/cezarion#1990): spec
// 2026-10-27-task-communication-protocol § 2, § 4, § 5 and § 13. These tests need the run engine: its store
// hooks settle requests with no read, and a message to a parked peer opens a scheduler continuation.
describe('peer conversations', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  const permissions = ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'] as const;
  /** Another root task of the project. `provisioned: false` is a top-level run that never opened a session. */
  function peer(status: RunRecord['status'] = RUN_STATUS.running, provisioned = true) {
    const run = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    {
      const { status: fixtureStatus, ...fixtureExtras }: NonNullable<Parameters<typeof setRunStatus>[3]> & { status: Parameters<typeof setRunStatus>[2] } = { status, ...(provisioned ? { delegation: { role: 'root', permissions: [...permissions], receipts: [] } } : {}) };
      setRunStatus(f.store, run.id, fixtureStatus, fixtureExtras);
    }
    return { id: run.id, caller: f.credentials.authenticate(f.credentials.issue('project', run.id, randomUUID()))! };
  }
  const message = (recipientRunId: string, kind: ConversationSendRequest['kind'] = 'request', extra: Partial<ConversationSendRequest> = {}): ConversationSendRequest =>
    ({ id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600, ...extra });
  const ledger = (id: string) => { const run = f.store.getRun(id); return run?.delegation?.role === 'root' ? run.delegation.conversation : undefined; };
  const projections = (id: string) => f.store.eventLog.readEvents(id).filter(event => event.type === 'conversation-message' || event.type === 'request-outcome').map(event => String(event.projectionId));

  it('R15 after a peer\'s deletion the requester\'s history, wait and cancel still work, and its request settles deleted', async () => {
    const b = peer();
    const progress = await f.service.send(f.caller, message(b.id, 'progress'));
    const open = await f.service.send(f.caller, message(b.id));
    // Deleted while it runs: a peer that settled first would settle the request first (R17).
    expect(f.store.retention.deleteRun(b.id)).toBe(true);
    // The deletion itself reconciles the live ledgers: no read is needed to settle it.
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    const history = await f.service.conversation(f.caller, { recipientRunId: b.id });
    expect(history.messages.map(entry => entry.id)).toEqual([progress.message.id, open.message.id]);
    expect(history.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    const register = vi.spyOn(f.manager, 'registerRequestWait').mockReturnValue({ id: randomUUID(), workerIds: [], requestIds: [open.message.id], deadline: new Date(Date.now() + 600_000).toISOString(), phase: 'registered', outcomes: [] });
    await f.service.waitRequests(f.caller, { requestIds: [open.message.id], timeoutSeconds: 600 });
    expect(register).toHaveBeenCalledOnce();
    expect(await f.service.cancelRequest(f.caller, { requestId: open.message.id })).toMatchObject({ status: 'deleted' });
    await expect(f.service.send(f.caller, message(b.id, 'progress'))).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it.each([['review', 'completed-without-reply'], ['done', 'completed-without-reply'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const)(
    'R17 a requester resting at review, out of memory, settles its request when the peer reaches %s, with no read', async (status, outcome) => {
      const b = peer();
      const open = await f.service.send(f.caller, message(b.id));
      setRunStatus(f.store, f.parent.id, RUN_STATUS.review);
      vi.spyOn(f.store, 'listRuns').mockReturnValue([]);
      setRunStatus(f.store, b.id, RUN_STATUS[status]);
      expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: outcome })]);
      expect(projections(f.parent.id)).toContain(`request-outcome:${open.message.id}`);
    });

  it('§ 5 a parked peer with no live session: a message opens a scheduler continuation; past the budget it opens the budget human wait instead', async () => {
    // A parked task as a closed session leaves it: its one agent step ran and kept its session.
    const parked = () => {
      const run = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] });
      f.store.updateStep(run.id, 'task', { status: STEP_STATUS.running, sessionId: 'previous-session', backend: 'claude' });
      setRunStatus(f.store, run.id, RUN_STATUS.waiting, { currentStepId: 'task', delegation: { role: 'root', permissions: [...permissions], receipts: [] } });
      return run;
    };
    const b = parked();
    const woken = await f.service.send(f.caller, message(b.id, 'progress', { text: 'wake up' }));
    expect(f.store.getRun(b.id)).toMatchObject({ status: RUN_STATUS.queued, continuationMessage: expect.objectContaining({ text: expect.stringContaining('queued messages') }) });
    expect(f.store.getRun(b.id)?.agentInputs?.find(input => input.id === woken.message.id)?.deliveredAt).toBeUndefined();
    const c = parked();
    f.store.updateRun(c.id, { automaticWakes: 40 });
    const held = await f.service.send(f.caller, message(c.id, 'progress', { text: 'held' }));
    expect(f.store.getRun(c.id)?.status).toBe(RUN_STATUS.waiting);
    expect(f.store.getRun(c.id)?.continuationMessage).toBeUndefined();
    expect(f.store.getRun(c.id)?.waits).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, via: WAIT_VIA.budget, phase: WAIT_PHASE.open })]);
    expect(f.store.getRun(c.id)?.agentInputs?.find(input => input.id === held.message.id)?.deliveredAt).toBeUndefined();
  });

  it.each(['done', 'failed', 'cancelled'] as const)('§ 5 a sender that ends %s settles its open peer request sender-closed', async status => {
    const b = peer();
    const open = await f.service.send(f.caller, message(b.id));
    setRunStatus(f.store, f.parent.id, RUN_STATUS[status]);
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'sender-closed' })]);
    // The peer's late reply is recorded and reopens nothing.
    expect((await f.service.reply(b.caller, message(f.parent.id, 'reply', { requestId: open.message.id }))).outcome).toMatchObject({ status: 'sender-closed' });
  });

  it('R15 a requester resting at review, out of memory, settles its request deleted when the peer is deleted, with no read', async () => {
    const b = peer();
    const open = await f.service.send(f.caller, message(b.id));
    setRunStatus(f.store, f.parent.id, RUN_STATUS.review);
    // The requester has left the live set the run manager's global pass reads.
    vi.spyOn(f.store, 'listRuns').mockReturnValue([]);
    expect(f.store.retention.deleteRun(b.id)).toBe(true);
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    expect(projections(f.parent.id)).toContain(`request-outcome:${open.message.id}`);
  });

  it('R15 a deletion reads only the ledgers that name the deleted peer', async () => {
    const b = peer(); const c = peer(); const d = peer();
    const open = await f.service.send(f.caller, message(b.id));
    // C's and D's ledgers hold conversations that never name B. C has left memory; D is held.
    await f.service.send(c.caller, message(d.id, 'progress'));
    await f.service.send(d.caller, message(c.id, 'progress'));
    setRunStatus(f.store, c.id, RUN_STATUS.done);
    f.store.flush();
    expect(f.store.heldIds()).not.toContain(c.id);
    expect(f.store.listConversationRootIds(b.id)).toEqual([f.parent.id]);
    const read = vi.spyOn(f.store, 'getRun');
    expect(f.store.retention.deleteRun(b.id)).toBe(true);
    expect(read.mock.calls.map(([id]) => id)).not.toContain(c.id);
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    expect(f.store.listConversationRootIds()).toEqual(expect.arrayContaining([f.parent.id, c.id, d.id]));
  });
});
