import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runPersistence } from '../runs/run-store-open.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { admissionRefusal } from '../runs/worker-execution.ts';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import { projectConversationEvents } from './conversations.ts';
import { conversationSendResultSchema, conversationSendEffectSchema, requestOutcomeSchema, conversationInspectResultSchema, conversationStateSchema, inboxReceiptRequestSchema, inboxReceiptResultSchema, inboxReserveResultSchema } from '@open-mercato/cezar-contract/conversations';
import { inboxClaimSchema } from '@open-mercato/cezar-contract/agent-input';
import { ownedWorkspace } from '@open-mercato/cezar-contract/delegation';
import { readPersistedText } from '../runs/run-store.testkit.ts';

const INVALID_PENDING_RECEIPT_STATUS = 'pending';

describe('message inbox contract', () => {
  const at = '2026-09-06T12:00:00.000Z';
  const message = { id: randomUUID(), senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'request',
    text: 'Need a decision', createdAt: at, requestHash: 'a'.repeat(64), state: 'accepted' };
  const outcome = { requestId: message.id, status: 'replied', observedAt: at, replyId: randomUUID() };
  const receiptId = randomUUID();

  it('accepts all message effects and legacy receipts without an effect', () => {
    const legacy = { message, delivery: 'queued', outcome };
    expect(conversationSendResultSchema.parse(legacy)).toEqual(legacy);
    for (const effect of conversationSendEffectSchema.options) {
      expect(conversationSendResultSchema.parse({ ...legacy, effect })).toEqual({ ...legacy, effect });
    }
    expect(conversationSendResultSchema.safeParse({ ...legacy, effect: 'delivered' }).success).toBe(false);
  });
  it('parses bounded snapshots and requires receipt fields together only for a nonempty batch', () => {
    const batch = { messages: [message], outcomes: [outcome], receiptId, expiresAt: '2026-09-06T12:02:00.000Z' };
    expect(inboxReserveResultSchema.parse(batch)).toEqual(batch);
    expect(inboxReserveResultSchema.parse({ messages: [], outcomes: [] })).toEqual({ messages: [], outcomes: [] });
    for (const invalid of [
      { messages: [], outcomes: [], receiptId, expiresAt: batch.expiresAt },
      { messages: [message], outcomes: [] },
      { messages: [message], outcomes: [], receiptId },
      { messages: [message], outcomes: [], expiresAt: batch.expiresAt },
      { ...batch, messages: Array.from({ length: 33 }, (_, n) => ({ ...message, id: randomUUID(), text: `message ${n}` })) },
      { ...batch, outcomes: Array.from({ length: 33 }, () => ({ ...outcome, requestId: randomUUID() })) },
    ]) expect(inboxReserveResultSchema.safeParse(invalid).success).toBe(false);
  });

  it('validates receipt identity, acknowledgement status and inspection hint separately from persisted state', () => {
    const claim = { receiptId, generation: randomUUID(), expiresAt: '2026-09-06T12:02:00.000Z' };
    const memberIds = [randomUUID(), randomUUID()];
    expect(inboxClaimSchema.parse(claim)).toEqual(claim);
    expect(inboxClaimSchema.parse({ ...claim, memberIds })).toEqual({ ...claim, memberIds });
    expect(inboxClaimSchema.safeParse({ ...claim, memberIds: [] }).success).toBe(false);
    expect(inboxClaimSchema.safeParse({ ...claim, memberIds: [memberIds[0], memberIds[0]] }).success).toBe(false);
    expect(inboxClaimSchema.parse({ ...claim, acknowledgedAt: at })).toEqual({ ...claim, acknowledgedAt: at });
    expect(inboxClaimSchema.safeParse({ ...claim, generation: 'bad' }).success).toBe(false);
    expect(inboxClaimSchema.safeParse({ ...claim, expiresAt: 'tomorrow' }).success).toBe(false);
    expect(inboxReceiptRequestSchema.parse({ receiptId })).toEqual({ receiptId });
    expect(inboxReceiptRequestSchema.safeParse({ receiptId, generation: claim.generation }).success).toBe(false);
    for (const status of ['acknowledged', 'already-acknowledged', 'released']) {
      expect(inboxReceiptResultSchema.parse({ receiptId, status })).toEqual({ receiptId, status });
    }
    expect(inboxReceiptResultSchema.safeParse({ receiptId, status: INVALID_PENDING_RECEIPT_STATUS }).success).toBe(false);
    const inspection = { messages: [message], outcomes: [outcome], hint: 'Run message inbox' };
    expect(conversationInspectResultSchema.parse(inspection)).toEqual(inspection);
    expect(conversationStateSchema.safeParse(inspection).success).toBe(false);
  });
});

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
  it('reserves incoming messages across workers, preserves outcomes and acknowledges exact IDs', async () => {
    const a = await worker(); const b = await worker();
    const request = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: a.id, kind: 'request', text: 'Question', timeoutSeconds: 600 });
    const reply = await f.service.reply(a.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'reply', requestId: request.message.id, text: 'Answer', timeoutSeconds: 600 });
    const update = await f.service.send(b.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: 'Update', timeoutSeconds: 600 });
    const inspected = await f.service.conversation(f.caller, { recipientRunId: a.id });
    expect(conversationInspectResultSchema.parse(inspected).hint).toContain('Run hsq message inbox');
    expect(f.store.getRun(f.parent.id)?.agentInputs?.find(input => input.id === reply.message.id)?.deliveredAt).toBeUndefined();
    const batch = inboxReserveResultSchema.parse(await f.service.inbox(f.caller));
    expect(batch.messages.map(message => [message.id, message.senderRunId])).toEqual([[reply.message.id, a.id], [update.message.id, b.id]]);
    expect(batch.outcomes).toMatchObject([{ requestId: request.message.id, status: 'replied' }]);
    expect(inboxReserveResultSchema.parse(await f.service.inbox(f.caller))).toEqual({ messages: [], outcomes: [] });
    expect((await f.service.ackInbox(f.caller, { receiptId: batch.receiptId! })).status).toBe('acknowledged');
    expect((await f.service.ackInbox(f.caller, { receiptId: batch.receiptId! })).status).toBe('already-acknowledged');
    expect(f.store.getRun(f.parent.id)?.agentInputs?.filter(input => [reply.message.id, update.message.id].includes(input.id)).every(input => !!input.deliveredAt)).toBe(true);
    expect((await f.service.conversation(f.caller, { recipientRunId: a.id })).hint).toBeUndefined();
  });
  it('keeps new arrivals outside a live receipt and leaves request obligations pending', async () => {
    const w = await worker();
    const first = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'Need decision', timeoutSeconds: 600 });
    const batch = await f.service.inbox(f.caller);
    const later = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: 'More context', timeoutSeconds: 600 });
    expect(batch.messages.map(message => message.id)).toEqual([first.message.id]);
    expect(batch.outcomes).toEqual([]);
    expect((await f.service.inbox(f.caller)).messages).toEqual([]);
    await f.service.ackInbox(f.caller, { receiptId: batch.receiptId! });
    expect((await f.service.inbox(f.caller)).messages.map(message => message.id)).toEqual([later.message.id]);
    expect((await f.service.conversation(w.caller, { recipientRunId: f.parent.id })).outcomes).toEqual([]);
  });
  it('hints only for unread incoming messages in the inspected pair', async () => {
    const a = await worker(); const b = await worker();
    const outbound = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: a.id, kind: 'progress', text: 'Outbound', timeoutSeconds: 600 });
    expect((await f.service.conversation(f.caller, { recipientRunId: a.id })).hint).toBeUndefined();
    expect((await f.service.conversation(a.caller, { recipientRunId: f.parent.id })).hint).toContain('Inbox will show them again intentionally');
    await f.service.send(b.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: 'Other pair', timeoutSeconds: 600 });
    expect((await f.service.conversation(f.caller, { recipientRunId: a.id })).hint).toBeUndefined();
    expect(f.store.getRun(a.id)?.agentInputs?.find(input => input.id === outbound.message.id)?.deliveredAt).toBeUndefined();
  });
  it('limits snapshots to 32 messages and 100000 text characters without splitting a message', async () => {
    const w = await worker();
    for (let i = 0; i < 32; i++) await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: `item ${i}`, timeoutSeconds: 600 });
    const full = await f.service.inbox(f.caller);
    expect(full.messages).toHaveLength(32);
    await f.service.ackInbox(f.caller, { receiptId: full.receiptId! });
    for (const text of ['a'.repeat(60_000), 'b'.repeat(40_000), 'last']) await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text, timeoutSeconds: 600 });
    const bounded = await f.service.inbox(f.caller);
    expect(bounded.messages.map(message => message.text.length)).toEqual([60_000, 40_000]);
    await f.service.ackInbox(f.caller, { receiptId: bounded.receiptId! });
    expect((await f.service.inbox(f.caller)).messages.map(message => message.text)).toEqual(['last']);
  });
  it('permits a worker to read only its parent and denies unrelated callers or receipts', async () => {
    const a = await worker(); const b = await worker();
    const incoming = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: a.id, kind: 'progress', text: 'For A', timeoutSeconds: 600 });
    await f.service.send(f.caller, { id: randomUUID(), recipientRunId: b.id, kind: 'progress', text: 'For B', timeoutSeconds: 600 });
    const batch = await f.service.inbox(a.caller);
    expect(batch.messages.map(message => message.id)).toEqual([incoming.message.id]);
    await expect(f.service.ackInbox(b.caller, { receiptId: batch.receiptId! })).rejects.toMatchObject({ code: 'denied_scope' });
    const foreign = f.credentials.authenticate(f.credentials.issue('other', f.parent.id, randomUUID()))!;
    await expect(f.service.inbox(foreign)).rejects.toMatchObject({ code: 'denied_scope' });
    await f.service.releaseInbox(a.caller, { receiptId: batch.receiptId! });
  });
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
  it('keeps provider acknowledgement time separate from a later repaired projection', async () => {
    const w = await worker();
    const message = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Result', timeoutSeconds: 600 });
    const deliveredAt = '2026-09-22T14:32:54.554Z';
    f.store.commitOutcome(w.id, { kind: 'delivered', inputIds: f.store.getRun(w.id)!.agentInputs!.map(input => input.id), at: deliveredAt });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-22T15:00:00.000Z'));
    try {
      projectConversationEvents(f.store, f.store.getRun(f.parent.id)!);
      for (const id of [f.parent.id, w.id]) expect(f.store.eventLog.readEvents(id).find(event => event.type === 'conversation-message' && event.delivery === 'delivered'))
        .toMatchObject({ message: { id: message.message.id }, deliveredAt, ts: '2026-09-22T15:00:00.000Z' });
    } finally { vi.useRealTimers(); }
  });
  // hearsay-tools/squawk#867: each store refusal carries its own cause and next step.
  const spawnNext = 'spawn a new worker with the instruction';
  it.each([
    ['an unfinished checkpoint', (id: string) => { f.store.workerExecutions.commitWorkerExecutionStart(id); },
      'the previous execution is not proven finished (checkpoint starting)', `retry the same command after it ends; if this repeats, ${spawnNext}`],
    ['an abandoned execution', (id: string) => {
      const path = join(f.root, '.ai/cezar/runs', `${id}.execution.json`);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), abandoned: true }), { mode: 0o600 });
    }, 'the worker execution was abandoned', spawnNext],
    ['a destroy request', (id: string) => {
      const run = f.store.getRun(id)!;
      f.store.commitDelegation([{ id, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['branch'] } } as never }]);
    }, 'the worker is being destroyed', spawnNext],
  ])('refuses a new execution after %s with its cause and next step', async (_, arrange, cause, next) => {
    const w = await completedWorker();
    arrange(w.id);
    let thrown: unknown;
    try { f.store.workerExecutions.commitWorkerExecutionStart(w.id); } catch (error) { thrown = error; }
    expect(admissionRefusal(thrown, 'fallback')).toEqual({ ok: false, error: cause, next });
  });
  it('keeps the fallback text only for an admission error without a message', () => {
    expect(admissionRefusal(new Error(''), 'fallback')).toEqual({ ok: false, error: 'fallback' });
    expect(admissionRefusal(new Error('disk full'), 'fallback')).toEqual({ ok: false, error: 'disk full' });
  });
  it('refuses --resume of a cancelled worker whose branch ref is gone, accepting nothing', async () => {
    const w = await completedWorker('cancelled');
    await ensureOwnedWorkspace(f.root, f.store.getRun(w.id)!);
    const delegation = f.store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw new Error('expected a worker');
    execFileSync('git', ['update-ref', '-d', `refs/heads/${ownedWorkspace(delegation.workspace).branch}`], { cwd: f.root });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true }))
      .rejects.toMatchObject({ code: 'incompatible_state', message: expect.stringMatching(/branch .* is missing/) });
  });
  it('refuses --resume of a cancelled worker whose worktree is gone, accepting nothing', async () => {
    const w = await completedWorker('cancelled');
    const before = structuredClone(f.store.getRun(w.id));
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true }))
      .rejects.toMatchObject({ code: 'incompatible_state', message: expect.stringMatching(/worktree or branch is gone/) });
    expect(f.store.getRun(w.id)).toEqual(before);
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
  });
  it.each(['queued', 'running', 'waiting'] as const)('accepts a two-hour request for an active %s recipient', async status => {
    const w = await worker();
    setRunStatus(f.store, w.id, status);
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'Review', timeoutSeconds: 7200 });
    expect(sent.message.state).toBe('accepted');
    expect(Date.parse(sent.message.deadline!) - Date.parse(sent.message.createdAt)).toBe(7_200_000);
  });
  it.each(['queued', 'running', 'waiting'] as const)('refuses an extended --resume deadline for a %s worker without accepting input', async status => {
    const w = await worker();
    setRunStatus(f.store, w.id, status);
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request',
      text: 'Review', resume: true, timeoutSeconds: 86400 })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
  });
  it('keeps a cancelled request cancelled when a reply arrives', async () => {
    const w = await worker();
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'Report', timeoutSeconds: 600 });
    const cancelled = await f.service.cancelRequest(f.caller, { requestId: sent.message.id });
    const reply = await f.service.reply(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'reply', requestId: sent.message.id, text: 'Report', timeoutSeconds: 600 });
    expect(reply.outcome).toEqual(cancelled);
  });
  it.each([false, true])('records the first reply after expiry as replied late (timeout observed: %s)', async observed => {
    const w = await worker();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
      const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id,
        kind: 'request', text: 'Report back', timeoutSeconds: 600 });
      vi.setSystemTime(new Date('2026-10-18T10:45:00.000Z'));
      if (observed) expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes[0]?.status).toBe('timed-out');
      const request = { id: randomUUID(), recipientRunId: f.parent.id, kind: 'reply' as const,
        requestId: sent.message.id, text: 'Fixed', timeoutSeconds: 600 };
      const reply = await f.service.reply(w.caller, request);
      expect(reply).toMatchObject({ message: { state: 'late' }, outcome: { status: 'replied-late', replyId: request.id } });
      expect(await f.service.reply(w.caller, request)).toEqual({ ...reply, effect: 'unchanged' });
      const later = await f.service.reply(w.caller, { ...request, id: randomUUID() });
      expect(later.outcome?.replyId).toBe(request.id);
      expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes).toEqual([reply.outcome]);
      const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
      expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { outcomes: [reply.outcome] } });
      reopened.persistence.flush();
      for (const id of [f.parent.id, w.id]) {
        const events = f.store.eventLog.readEvents(id).filter(event => event.type === 'request-outcome');
        expect(events.at(-1)).toMatchObject({ outcome: { status: 'replied-late', replyId: request.id } });
        expect(events.filter(event => event.type === 'request-outcome' && requestOutcomeSchema.safeParse(event.outcome).data?.status === 'replied-late')).toHaveLength(1);
      }
    } finally { vi.useRealTimers(); }
  });
  it('atomically accepts one obligation and input across concurrent retries and restart', async () => {
    const w = await worker(); const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Which file?', timeoutSeconds: 600 };
    const [a, b] = await Promise.all([f.service.send(f.caller, request), f.service.send(f.caller, request)]);
    expect(b).toEqual({ ...a, effect: 'unchanged' }); expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1);
    await expect(f.service.send(f.caller, { ...request, text: 'changed' })).rejects.toMatchObject({ code: 'invalid_input' });
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [a.message], outcomes: [] } });
    expect(reopened.getRun(w.id)?.agentInputs?.[0]).toMatchObject({ id: request.id, conversation: { senderRunId: f.parent.id, recipientRunId: w.id, kind: 'request' } }); reopened.persistence.flush();
  });
  it('allows worker request, parent follow-up and reply, preserving first settlement and late replies', async () => {
    const w = await worker(); const req = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'Approve approach?', timeoutSeconds: 600 });
    await f.service.followUp(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, requestId: req.message.id, kind: 'follow-up', text: 'More context', timeoutSeconds: 600 });
    const reply = { id: randomUUID(), recipientRunId: w.id, requestId: req.message.id, kind: 'reply' as const, text: 'Yes', timeoutSeconds: 600 };
    expect(await f.service.reply(f.caller, reply)).toMatchObject({ outcome: { status: 'replied', replyId: reply.id } });
    expect(await f.service.reply(f.caller, reply)).toMatchObject({ outcome: { status: 'replied', replyId: reply.id } });
    expect(await f.service.reply(f.caller, { ...reply, id: randomUUID() })).toMatchObject({ message: { state: 'late' }, outcome: { replyId: reply.id } });
    expect((await f.service.conversation(w.caller, { recipientRunId: f.parent.id })).outcomes).toHaveLength(1);
  });
  it('rejects peer routes, forged callers, secrets and unrelated correlation before accepting', async () => {
    const a = await worker(); const b = await worker();
    const req = { id: randomUUID(), recipientRunId: b.id, kind: 'request' as const, text: 'hello', timeoutSeconds: 600 };
    await expect(f.service.send(a.caller, req)).rejects.toMatchObject({ code: 'denied_scope' });
    await expect(f.service.send({ ...f.caller }, req)).rejects.toMatchObject({ code: 'denied_scope' });
    f.store.redaction.registerSessionSecret(f.token);
    await expect(f.service.send(f.caller, { ...req, text: f.token })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(f.service.reply(f.caller, { ...req, kind: 'reply', requestId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
    expect(f.store.getRun(b.id)?.agentInputs ?? []).toEqual([]);
  });
  it('records rejected terminal delivery without creating an obligation', async () => {
    const w = await worker(); setRunStatus(f.store, w.id, RUN_STATUS.review);
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    expect(sent).toMatchObject({ delivery: 'not-delivered', message: { state: 'continuation-required' } });
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
    expect(sent.message.deadline).toBeUndefined();
    await expect(f.service.cancelRequest(f.caller, { requestId: sent.message.id })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('publishes neither ledger nor input when atomic persistence fails', async () => {
    const w = await worker();
    vi.spyOn(runPersistence(f.store), 'persist').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 })).rejects.toThrow('disk unavailable');
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
  });
  it('keeps rejected receipts rejected after Continue and replays event projections without extra inputs', async () => {
    const w = await worker(); setRunStatus(f.store, w.id, RUN_STATUS.review);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'question', timeoutSeconds: 600 };
    const first = await f.service.send(f.caller, request);
    setRunStatus(f.store, w.id, RUN_STATUS.running);
    expect(await f.service.send(f.caller, request)).toEqual({ ...first, effect: 'unchanged' });
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
    expect(f.store.eventLog.readEvents(w.id).filter(event => event.type === 'conversation-message')).toHaveLength(1);
    expect(await f.service.send(f.caller, { ...request, id: randomUUID() })).toMatchObject({ message: { state: 'accepted' }, delivery: 'queued' });
  });
  it('caps undelivered inputs without evicting receipts', async () => {
    const w = await worker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'update', timeoutSeconds: 600 };
    for (let i = 0; i < 32; i++) await f.service.send(f.caller, { ...request, id: i ? randomUUID() : request.id });
    await expect(f.service.send(f.caller, { ...request, id: randomUUID() })).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(await f.service.send(f.caller, request)).toMatchObject({ message: { id: request.id } });
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(32);
  });

  it('records a late message reply after parent Finish without waking the terminal parent', async () => {
    const w = await worker();
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    // Hold lifecycle cancellation at its boundary to exercise a still-active worker reply.
    const cancel = vi.spyOn(f.manager, 'cancel').mockReturnValue(true);
    setRunStatus(f.store, parent.id, RUN_STATUS.done, { delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } });
    const reply = await f.service.reply(w.caller, { id: randomUUID(), recipientRunId: parent.id, kind: 'reply', requestId: sent.message.id, text: 'answer', timeoutSeconds: 600 });
    expect(reply).toMatchObject({ message: { state: 'late' }, delivery: 'not-delivered', outcome: { status: 'sender-closed' } });
    expect(f.store.getRun(parent.id)?.agentInputs ?? []).toEqual([]);
    cancel.mockRestore();
  });

  it('redacts recognizable secrets before the ledger, queue, receipts, inspection, disk and event projections', async () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '1');
    const w = await worker(); const token = 'ghp_' + 'syntheticTokenForRedaction'.repeat(2);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: `Inspect ${token}`, timeoutSeconds: 600 };
    const sent = await f.service.send(f.caller, request);
    expect(sent.message.text).toBe('Inspect [REDACTED]');
    expect(await f.service.send(f.caller, request)).toEqual({ ...sent, effect: 'unchanged' });
    await expect(f.service.send(f.caller, { ...request, text: 'Inspect [REDACTED]' })).rejects.toMatchObject({ code: 'invalid_input' });
    const inspected = await f.service.conversation(f.caller, { recipientRunId: w.id });
    expect(inspected.messages[0]?.text).toBe('Inspect [REDACTED]');
    expect(f.store.getRun(w.id)?.agentInputs?.[0]?.text).toBe('Inspect [REDACTED]');
    const surfaces = [f.store.getRun(f.parent.id)?.delegation, f.store.getRun(w.id)?.agentInputs, sent, inspected,
      f.store.eventLog.readEvents(f.parent.id), f.store.eventLog.readEvents(w.id), readPersistedText(join(f.root, '.ai/cezar'))];
    for (const surface of surfaces) { expect(JSON.stringify(surface)).not.toContain(token); expect(JSON.stringify(surface)).toContain('[REDACTED]'); }
  });

  it('repairs projection failure on accepted send retry and notifies delivery without another input', async () => {
    const w = await worker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'update', timeoutSeconds: 600 };
    const notify = vi.spyOn(f.manager, 'deliverConversationInput');
    vi.spyOn(f.store.eventLog, 'appendEvent').mockImplementationOnce(() => { throw Error('projection unavailable'); });
    await expect(f.service.send(f.caller, request)).resolves.toMatchObject({ effect: 'applied', delivery: 'queued', message: { id: request.id, state: 'accepted' } });
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1); expect(notify).not.toHaveBeenCalled();
    expect(await f.service.send(f.caller, request)).toMatchObject({ delivery: 'queued' });
    expect(notify).toHaveBeenCalledWith(w.id);
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1);
    expect(f.store.eventLog.readEvents(w.id).filter(event => event.type === 'conversation-message')).toHaveLength(1);
  });
  it('repairs cancellation projection and wake reconciliation on retry without another settlement', async () => {
    const w = await worker();
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const reconcile = vi.spyOn(f.manager, 'reconcileWorkerWaits');
    vi.spyOn(f.store.eventLog, 'appendEvent').mockImplementationOnce(() => { throw Error('projection unavailable'); });
    await expect(f.service.cancelRequest(f.caller, { requestId: sent.message.id })).rejects.toThrow('projection unavailable');
    reconcile.mockClear();
    const outcome = await f.service.cancelRequest(f.caller, { requestId: sent.message.id });
    expect(outcome.status).toBe('cancelled'); expect(reconcile).toHaveBeenCalled();
    expect(f.store.eventLog.readEvents(w.id).filter(event => event.type === 'request-outcome')).toHaveLength(1);
    expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes).toHaveLength(1);
  });

});
