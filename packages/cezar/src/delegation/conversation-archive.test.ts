import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationSendRequest } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { conversationOf } from '../runs/task-rights.ts';
import { CONVERSATION_ARCHIVE_THRESHOLD } from '../runs/conversation-compaction.ts';
import { assertRequestWaitScope } from '../workflows/wait-scope.ts';
import { projectConversationEvents } from './conversations.ts';
import { fixture } from './service-engine.testkit.ts';

sealTestRunners(claudeRunner);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Settled history leaves the root's row for conversation_archive; only active load counts
// (hearsay-tools/squawk#4192). Each test advances a faked clock past the activity window.
describe('archived conversation history', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-24T12:00:00.000Z'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const run of f.store.queries.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks();
  });
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const ledger = (rootId = f.parent.id) => conversationOf(f.store.getRun(rootId));
  const inRow = (id: string, rootId = f.parent.id) => ledger(rootId)?.messages.some(entry => entry.id === id) ?? false;
  const send = (recipientRunId: string, kind: ConversationSendRequest['kind'] = 'request', extra: Partial<ConversationSendRequest> = {}): ConversationSendRequest =>
    ({ id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600, ...extra });
  const progress = (count: number, senderRunId: string, recipientRunId: string): ConversationMessage[] => Array.from({ length: count }, (_, n) =>
    ({ id: randomUUID(), senderRunId, recipientRunId, kind: 'progress', text: `m${n}`, createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' }));
  /** Every queued input delivered, and every participant's transcript up to date. */
  function settle(rootId = f.parent.id): void {
    for (const run of f.store.queries.listRuns()) {
      const ids = (f.store.getRun(run.id)?.agentInputs ?? []).filter(input => !input.deliveredAt).map(input => input.id);
      if (ids.length) f.store.commitOutcome(run.id, { kind: 'delivered', inputIds: ids, at: new Date().toISOString() });
    }
    projectConversationEvents(f.store, f.store.getRun(rootId)!);
  }
  /** `messages` join root `rootId`'s ledger through the store, delivered and projected. */
  function seed(messages: ConversationMessage[], rootId = f.parent.id): void {
    const state = ledger(rootId) ?? { messages: [], outcomes: [] };
    f.store.commitConversation(rootId, { ...state, messages: [...state.messages, ...messages] });
    settle(rootId);
  }
  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    setRunStatus(f.store, workerId, RUN_STATUS.running);
    return { id: workerId, caller: f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))! };
  }
  async function doneWorker() {
    const w = await worker();
    f.manager.cancel(w.id);
    await f.manager.awaitRunTermination(w.id, 5_000);
    f.store.updateStep(w.id, 'task', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(w.id);
    setRunStatus(f.store, w.id, RUN_STATUS.done);
    f.store.workerExecutions.commitWorkerExecutionComplete(w.id, generation);
    return w;
  }
  function peer(status: RunRecord['status'] = RUN_STATUS.running) {
    const run = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    setRunStatus(f.store, run.id, status, { delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
    return { id: run.id };
  }

  it('accepts a request, progress, a peer request and a worker resume after more than 1,024 settled family messages', async () => {
    const w = await worker();
    const finished = await doneWorker();
    const b = peer();
    // The live case: a row full of delivered history, no open request and no queued input.
    const history = progress(1024, f.parent.id, w.id);
    seed(history);
    expect(ledger()?.messages).toHaveLength(1024);
    later(MINUTE);
    expect(await f.service.send(f.caller, send(w.id))).toMatchObject({ effect: 'applied', message: { state: 'accepted' } });
    expect(ledger()!.messages.length).toBeLessThan(CONVERSATION_ARCHIVE_THRESHOLD);
    expect(await f.service.send(f.caller, send(w.id, 'progress'))).toMatchObject({ effect: 'applied' });
    expect(await f.service.send(f.caller, send(b.id))).toMatchObject({ effect: 'applied', message: { relationship: 'peer' } });
    expect(await f.service.send(f.caller, send(finished.id, 'request', { resume: true }))).toMatchObject({ message: { state: 'accepted', resumed: true } });
    // Nothing left the ledger: every archived message is still found by its ID.
    for (const entry of [history[0]!, history[1023]!]) {
      expect(inRow(entry.id)).toBe(false);
      expect(f.store.conversations.findMessage(f.parent.id, entry.id)).toEqual(entry);
    }
  });

  it('still refuses with capacity_limit when 1,024 entries are active', async () => {
    const w = await worker();
    seed(progress(1024, f.parent.id, w.id));
    // Within the activity window nothing is settled long enough to leave.
    await expect(f.service.send(f.caller, send(w.id))).rejects.toMatchObject({ code: 'capacity_limit' });
    await expect(f.service.send(f.caller, send(w.id, 'progress'))).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(ledger()?.messages).toHaveLength(1024);
  });

  it('keeps an exact retry, a late reply, a follow-up, a cancel, a request wait and a routed question\'s answer working on archived IDs', async () => {
    const w = await worker();
    const askRequest = send(w.id);
    const asked = await f.service.send(f.caller, askRequest);
    const replyRequest = send(f.parent.id, 'reply', { requestId: asked.message.id });
    const replied = await f.service.reply(w.caller, replyRequest);
    const expiring = await f.service.send(f.caller, send(w.id, 'request', { timeoutSeconds: 60 }));
    const question: ConversationMessage = { id: randomUUID(), senderRunId: w.id, recipientRunId: f.parent.id, kind: 'request', text: 'Which file?',
      createdAt: new Date().toISOString(), requestHash: 'b'.repeat(64), state: 'accepted', question: { questions: [{ question: 'Which file?', header: 'File' }] } };
    seed([question]);
    const answerRequest = send(w.id, 'reply', { requestId: question.id, text: 'File: a.ts' });
    const answer = await f.service.reply(f.caller, answerRequest);
    expect(answer.outcome).toMatchObject({ status: 'replied', replyId: answerRequest.id });
    later(2 * MINUTE);
    expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes).toContainEqual(expect.objectContaining({ requestId: expiring.message.id, status: 'timed-out' }));
    seed(progress(CONVERSATION_ARCHIVE_THRESHOLD, f.parent.id, w.id));
    // A timed-out request stays active for a day after its outcome.
    later(MINUTE);
    f.store.compactConversation(f.parent.id);
    expect(inRow(expiring.message.id)).toBe(true);
    expect(inRow(asked.message.id)).toBe(false);
    // Compaction runs again only once the row holds the threshold again.
    later(DAY);
    seed(progress(CONVERSATION_ARCHIVE_THRESHOLD, f.parent.id, w.id));
    later(MINUTE);
    f.store.compactConversation(f.parent.id);
    const named = { asked: asked.message.id, replied: replied.message.id, expiring: expiring.message.id, question: question.id, answer: answer.message.id };
    expect(Object.entries(named).filter(([, id]) => inRow(id)).map(([name]) => name)).toEqual([]);
    for (const id of Object.values(named)) expect(f.store.conversations.findMessage(f.parent.id, id)?.id).toBe(id);

    expect(await f.service.send(f.caller, askRequest)).toMatchObject({ effect: 'unchanged',
      message: { id: asked.message.id }, outcome: { status: 'replied', replyId: replyRequest.id } });
    expect(await f.service.reply(w.caller, replyRequest)).toMatchObject({ effect: 'unchanged', outcome: { status: 'replied' } });
    const late = await f.service.reply(w.caller, send(f.parent.id, 'reply', { requestId: expiring.message.id }));
    expect(late).toMatchObject({ message: { state: 'late' }, outcome: { status: 'replied-late', replyId: late.message.id } });
    for (const id of [f.parent.id, w.id]) expect(f.store.eventLog.hasProjection(id, `request-outcome:${expiring.message.id}:replied-late`)).toBe(true);
    expect(await f.service.send(f.caller, send(w.id, 'follow-up', { requestId: asked.message.id }))).toMatchObject({ effect: 'applied', message: { kind: 'follow-up' } });
    expect(await f.service.cancelRequest(f.caller, { requestId: asked.message.id })).toMatchObject({ status: 'replied', replyId: replyRequest.id });
    // `wait --request`: the service's own-request check, then the wait's scope check (which needs a live session to register).
    const register = vi.spyOn(f.manager, 'registerRequestWait').mockReturnValue({ id: randomUUID(), workerIds: [], requestIds: [asked.message.id],
      deadline: new Date(Date.now() + 600_000).toISOString(), phase: 'registered', outcomes: [] });
    await f.service.waitRequests(f.caller, { requestIds: [asked.message.id], timeoutSeconds: 600 });
    expect(register).toHaveBeenCalledOnce();
    expect(() => assertRequestWaitScope(f.store.getRun(f.parent.id)!, [asked.message.id], id => f.store.getRun(id), f.store.conversations)).not.toThrow();
    expect(await f.service.reply(f.caller, answerRequest)).toMatchObject({ effect: 'unchanged', outcome: { status: 'replied', replyId: answerRequest.id } });
    await expect(f.service.reply(f.caller, send(w.id, 'reply', { requestId: question.id }))).rejects.toMatchObject({ message: 'This question was already answered' });

    // The late reply's outcome follows its request into the archive.
    settle();
    later(MINUTE);
    seed(progress(CONVERSATION_ARCHIVE_THRESHOLD, f.parent.id, w.id));
    later(MINUTE);
    f.store.compactConversation(f.parent.id);
    expect(ledger()?.outcomes.some(outcome => outcome.requestId === expiring.message.id)).toBe(false);
    expect(f.store.conversations.findOutcome(f.parent.id, expiring.message.id)).toMatchObject({ status: 'replied-late', replyId: late.message.id });
  });

  it('keeps the row bounded over 3,000 messages and pages every message exactly once across row and archive', async () => {
    const w = await worker();
    const sent: string[] = [];
    for (let chunk = 0; chunk < 6; chunk++) {
      const messages = progress(500, chunk % 2 ? w.id : f.parent.id, chunk % 2 ? f.parent.id : w.id);
      sent.push(...messages.map(entry => entry.id));
      seed(messages);
      expect(ledger()!.messages.length).toBeLessThanOrEqual(500);
      later(MINUTE);
    }
    f.store.compactConversation(f.parent.id);
    expect(ledger()?.messages).toEqual([]);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await f.service.conversation(f.caller, { recipientRunId: w.id, ...(before ? { before } : {}) });
      seen.unshift(...page.messages.map(entry => entry.id));
      before = page.nextBefore;
    } while (before);
    expect(seen).toHaveLength(sent.length);
    expect(new Set(seen)).toEqual(new Set(sent));
  });

  it('deletes a root\'s archived history with the root', async () => {
    const b = peer(RUN_STATUS.done);
    const gone = randomUUID();
    const history = progress(CONVERSATION_ARCHIVE_THRESHOLD, b.id, gone);
    seed(history, b.id);
    later(MINUTE);
    f.store.compactConversation(b.id);
    expect(inRow(history[0]!.id, b.id)).toBe(false);
    expect(f.store.conversations.findMessage(b.id, history[0]!.id)).toEqual(history[0]);
    expect(f.store.retention.deleteRun(b.id)).toBe(true);
    f.store.persistence.flush();
    expect(f.store.conversations.findMessage(b.id, history[0]!.id)).toBeUndefined();
  });
});
