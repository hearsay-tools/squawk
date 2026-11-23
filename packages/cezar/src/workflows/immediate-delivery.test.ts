import '../core/every-runner.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import { captureSessions } from './runner-session-capture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput, ConversationMessage } from '@open-mercato/cezar-contract';
import { WAIT_VIA, makeTimerWait } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { wakeRetryClock } from './waits-wake.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import '../core/created-runners.testkit.ts';
import { manager, parent, store, timeline, until, useWorkerWaitFixture, worker } from './worker-wait-core.testkit.ts';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);
registerRunner(opencodeRunner);
registerRunner(piRunner);
registerRunner(ompRunner);

/** One accumulating conversation per root, committed the way the delegation service does. */
function conversation(rootId: string) {
  const messages: ConversationMessage[] = [];
  return (senderRunId: string, recipientRunId: string, kind: 'request' | 'progress', text: string): AgentInput => {
    const id = randomUUID(); const createdAt = new Date().toISOString();
    messages.push({ id, senderRunId, recipientRunId, kind, text, createdAt, requestHash: 'a'.repeat(64), state: 'accepted',
      ...(kind === 'request' ? { deadline: new Date(Date.now() + 600_000).toISOString() } : {}) });
    const input: AgentInput = { id, source: agentInputSchema.shape.source.enum.agent, parentRunId: rootId, text, createdAt, conversation: { senderRunId, recipientRunId, kind } };
    store.commitConversation(rootId, { messages: [...messages], outcomes: [] }, { recipientRunId, input });
    return input;
  };
}
const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);
const turnEnds = (runId: string) => store.eventLog.readEvents(runId).filter(event => event.type === 'turn-end').length;

describe('immediate conversation delivery (#505)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();

  it("delivers a parent message into a worker's long first turn and records when it is read", async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:steer-tool'); manager.enqueueOwnedRun(w.id);
    await until(() => store.eventLog.readEvents(w.id).some(event => event.type === 'tool-call'));
    const input = conversation(p.id)(p.id, w.id, 'progress', 'API correction: use v2');
    manager.deliverConversationInput(w.id);
    await until(() => !!inputOf(w.id, input.id)?.deliveredAt);
    expect(inputOf(w.id, input.id)?.consumedAt).toBeUndefined();
    expect(turnEnds(w.id), timeline(w.id)).toBe(0); // still the first turn
    await until(() => !!inputOf(w.id, input.id)?.consumedAt);
    // The first turn ends; the no-wait nudge's turn may follow at once (hearsay-tools/cezarion#1234).
    await until(() => turnEnds(w.id) >= 1, () => timeline(w.id));
    expect(store.eventLog.readEvents(w.id).filter(event => event.type === 'text' && String(event.text).includes('API correction')), timeline(w.id)).toHaveLength(1);
  });

  it("delivers a worker message into the parent's running turn", async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent('mock:steer-tool');
    const w = await worker(p.id);
    await until(() => store.eventLog.readEvents(p.id).some(event => event.type === 'tool-call'));
    const input = conversation(p.id)(w.id, p.id, 'progress', 'Worker progress: tests pass');
    manager.deliverConversationInput(p.id);
    await until(() => !!inputOf(p.id, input.id)?.deliveredAt);
    expect(turnEnds(p.id), timeline(p.id)).toBe(0);
    await until(() => !!inputOf(p.id, input.id)?.consumedAt);
    await until(() => turnEnds(p.id) === 1, () => timeline(p.id));
  });

  it('steers later input into a resumed opening turn', async () => {
    // Hold the tool call until the later line arrives, not for a fixed window (hearsay-tools/cezarion#1280).
    vi.stubEnv('CEZ_MOCK_STEER_LINES', '1');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    // The service's --resume path: the opening message rides continueRun, not the queue.
    const now = new Date().toISOString();
    const opening: ConversationMessage = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request',
      text: 'mock:steer-tool resume with a new instruction', createdAt: now, deadline: new Date(Date.now() + 600_000).toISOString(),
      requestHash: 'a'.repeat(64), state: 'accepted', resumed: true };
    const openingInput: AgentInput = { id: opening.id, source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: opening.text, createdAt: now,
      conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } };
    const seq = store.eventLog.readEvents(w.id).at(-1)!.seq;
    expect(manager.continueRun(w.id, { text: opening.text }, true, { rootId: p.id, state: { messages: [opening], outcomes: [] }, input: openingInput }).ok).toBe(true);
    await until(() => store.eventLog.readEvents(w.id).some(event => event.seq > seq && event.type === 'tool-call'));
    // The opening prompt was accepted; its replay checkpoint still waits for the turn to end.
    expect(inputOf(w.id, opening.id)?.deliveredAt).toBeTruthy();
    expect(store.getRun(w.id)?.continuationMessage).toBeDefined();
    const laterId = randomUUID();
    const later: ConversationMessage = { ...opening, id: laterId, kind: 'progress', text: 'Later scope guidance', deadline: undefined, resumed: undefined };
    const { deadline: _d, resumed: _r, ...laterMessage } = later;
    store.commitConversation(p.id, { messages: [opening, laterMessage], outcomes: [] }, { recipientRunId: w.id,
      input: { ...openingInput, id: laterId, text: later.text, conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'progress' } } });
    manager.deliverConversationInput(w.id);
    await until(() => !!inputOf(w.id, laterId)?.consumedAt);
    await until(() => store.eventLog.readEvents(w.id).some(event => event.seq > seq && event.type === 'turn-end'), () => timeline(w.id, seq));
    // Read inside the opening turn: no later than that turn's end, and answered before it.
    // The no-wait nudge's turn may follow at once (hearsay-tools/cezarion#1234), so count no turns.
    const openingEnd = store.eventLog.readEvents(w.id).find(event => event.seq > seq && event.type === 'turn-end')!;
    expect(Date.parse(inputOf(w.id, laterId)!.consumedAt!)).toBeLessThanOrEqual(Date.parse(openingEnd.ts));
    expect(store.eventLog.readEvents(w.id).filter(event => event.seq > seq && event.seq < openingEnd.seq && event.type === 'text'
      && String(event.text).includes('Later scope guidance')), timeline(w.id, seq)).toHaveLength(1);
    await until(() => store.getRun(w.id)?.continuationMessage === undefined);
    // The opening instruction was handled by that successful turn: its sender sees it read.
    expect(inputOf(w.id, opening.id)?.consumedAt).toBeTruthy();
  });

  it('drains a 40-message burst as FIFO submissions of 32 and 8', async () => {
    const sessionOf = captureSessions();
    vi.stubEnv('CEZ_MOCK_STEER_MS', '2500');
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:steer-tool'); manager.enqueueOwnedRun(w.id);
    await until(() => store.eventLog.readEvents(w.id).some(event => event.type === 'tool-call'));
    const spy = vi.spyOn(sessionOf(w.id), 'sendAgentMessage');
    const send = conversation(p.id);
    const inputs = Array.from({ length: 40 }, (_, i) => send(p.id, w.id, 'progress', `burst ${String(i).padStart(2, '0')}`));
    manager.deliverConversationInput(w.id);
    await until(() => inputs.every(input => !!inputOf(w.id, input.id)?.deliveredAt));
    const accepted = spy.mock.calls.filter((_, i) => spy.mock.results[i]?.value !== false).map(call => call[1] ?? []);
    expect(accepted.map(ids => ids.length)).toEqual([32, 8]);
    expect(accepted.flat()).toEqual(inputs.map(input => input.id));
  });

  // hearsay-tools/cezarion#1235 phase 3a (design § Messages beside a pending question): a pending
  // `cezar_ask` question does not hold conversation input. The messages go beside the card in one
  // submission, and the human's answer still answers it alone, through the answer seam.
  it('delivers messages beside a pending cezar_ask question in one submission, never as its answer', async () => {
    const sessionOf = captureSessions();
    const p = await parent('mock:cezar-ask');
    await until(() => store.eventLog.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const askSeq = store.eventLog.readEvents(p.id).find(event => event.type === 'ask.requested')!.seq;
    const card = () => store.getRun(p.id)?.waits?.find(wait => wait.kind === 'human' && wait.phase === 'open');
    expect(card()).toMatchObject({ via: WAIT_VIA.cezar_ask, askSeq });
    const w = await worker(p.id);
    const send = conversation(p.id);
    const beside = vi.spyOn(sessionOf(p.id), 'sendAgentMessage');
    const held = ['first finding', 'second finding', 'third finding'].map(text => send(w.id, p.id, 'progress', text));
    manager.deliverConversationInput(p.id);
    await until(() => held.every(input => !!inputOf(p.id, input.id)?.deliveredAt));
    const accepted = beside.mock.calls.filter((_, i) => beside.mock.results[i]?.value !== false);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]![1]).toEqual(held.map(input => input.id));
    expect(new Set(held.map(input => inputOf(p.id, input.id)?.deliveredAt)).size).toBe(1);
    // The card stays answerable: nothing answered it.
    expect(store.eventLog.readEvents(p.id).filter(event => event.type === 'human-input-delivered'), timeline(p.id)).toEqual([]);
    await until(() => store.getRun(p.id)?.status === 'waiting' && turnEnds(p.id) >= 2, () => timeline(p.id));
    expect(card()).toMatchObject({ askSeq });
    const write = vi.spyOn(sessionOf(p.id), 'sendMessage');
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:agent-echo use Vitest' }])).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const content = JSON.stringify(write.mock.calls[0]![0]);
    expect(content).toContain('use Vitest');
    for (const input of held) expect(content).not.toContain(input.id);
    expect(store.eventLog.readEvents(p.id).filter(event => event.type === 'human-input-delivered'), timeline(p.id)).toEqual([expect.objectContaining({ askSeq })]);
    await until(() => held.every(input => !!inputOf(p.id, input.id)?.consumedAt));
  });

  it('returns bundled messages to the queue when the answer turn fails (#505 review)', async () => {
    const p = await parent('mock:cezar-ask');
    await until(() => store.eventLog.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const held = conversation(p.id)(w.id, p.id, 'progress', 'finding held behind the question');
    manager.deliverConversationInput(p.id);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:request-error answer' }])).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(inputOf(p.id, held.id)?.deliveredAt).toBeUndefined();
    expect(inputOf(p.id, held.id)?.awaitingRead).toBeUndefined();
  });

  // hearsay-tools/squawk#1289: messages bundled behind an answer were handed to the transport, so a
  // clean close that requeues them unread is a failed wake delivery.
  it('counts one failed wake delivery when the answer turn closes cleanly with its bundled messages unread', async () => {
    // The harness never reads the answer line, so the session closes with its bundle unread.
    vi.stubEnv('CEZ_MOCK_DROP_LINES', 'answer never read');
    const sessionOf = captureSessions();
    const retry = wakeRetryClock();
    const p = await parent('mock:cezar-ask');
    await until(() => store.eventLog.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const held = conversation(p.id)(w.id, p.id, 'progress', 'finding bundled behind the answer');
    const write = vi.spyOn(sessionOf(p.id), 'sendMessage');
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'answer never read' }])).toBe(true);
    expect(JSON.stringify(write.mock.calls[0]![0])).toContain('finding bundled behind the answer');
    expect(inputOf(p.id, held.id)?.deliveredAt).toBeDefined();
    // The answer registers a wait of the agent's own, which keeps what the close leaves owed.
    store.commitWait(p.id, makeTimerWait());
    // Without a charge the requeued message reopens the run at once as a continuation.
    let charged = 0;
    const watch = () => { charged = Math.max(charged, store.getRun(p.id)?.waitDeliveryFailures ?? 0); };
    const stopWatch = onRunWrite(store.lifecycle, watch);
    try {
      sessionOf(p.id).end();
      await until(() => charged > 0 || !!store.getRun(p.id)?.steps.some(step => step.id.startsWith('continue-')), () => timeline(p.id));
    } finally { stopWatch(); }
    expect(charged).toBe(1);
    expect(inputOf(p.id, held.id)?.deliveredAt).toBeUndefined();
    expect(retry.delays).toHaveLength(1);
  });

  // hearsay-tools/squawk#3508: a clean close that aborts an acknowledgement in flight is a
  // retryable closed-session delivery failure, not a step failure.
  // Claude acknowledges with its own pipe write, which no harness can hold.
  it.each(['opencode', 'codex', 'pi', 'omp'] as const)('%s requeues a message whose acknowledgement a clean close aborts, and counts one failed wake delivery', async runner => {
    await withHeldAck(runner, async () => {
      const sessionOf = captureSessions();
      const retry = wakeRetryClock();
      const p = await parent('mock:hold', runner);
      await until(() => store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
      const w = await worker(p.id);
      const submitted = vi.spyOn(sessionOf(p.id), 'sendAgentMessage');
      const held = conversation(p.id)(w.id, p.id, 'progress', 'held-ack finding');
      manager.deliverConversationInput(p.id);
      // The submission is out and its HTTP acknowledgement is held.
      await until(() => submitted.mock.calls.some(([content]) => JSON.stringify(content).includes('held-ack finding')), () => timeline(p.id));
      // A wait of the agent's own keeps what the close leaves owed.
      store.commitWait(p.id, makeTimerWait());
      let charged = 0;
      const watch = () => { charged = Math.max(charged, store.getRun(p.id)?.waitDeliveryFailures ?? 0); };
      const stopWatch = onRunWrite(store.lifecycle, watch);
      try {
        sessionOf(p.id).end();
        await until(() => charged > 0 || store.getRun(p.id)?.status === 'failed', () => timeline(p.id));
      } finally { stopWatch(); }
      expect(store.eventLog.readEvents(p.id).filter(event => event.type === 'error').map(event => event.message)).toEqual([]);
      expect(store.getRun(p.id)?.status).not.toBe('failed');
      expect(inputOf(p.id, held.id)?.deliveredAt).toBeUndefined();
      expect(charged).toBe(1);
      expect(retry.delays).toHaveLength(1);
    }, 'held-ack finding');
  });

  it('returns a resumed opening input to the queue when its opening turn fails (#505 review)', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'inspect the working tree'); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    const now = new Date().toISOString();
    const opening: ConversationMessage = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request',
      text: 'mock:request-error resume instruction', createdAt: now, deadline: new Date(Date.now() + 600_000).toISOString(),
      requestHash: 'a'.repeat(64), state: 'accepted', resumed: true };
    const openingInput: AgentInput = { id: opening.id, source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: opening.text, createdAt: now,
      conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } };
    expect(manager.continueRun(w.id, { text: opening.text }, true, { rootId: p.id, state: { messages: [opening], outcomes: [] }, input: openingInput }).ok).toBe(true);
    await until(() => store.eventLog.readEvents(w.id).some(event => event.type === 'error'));
    await until(() => !manager.isActive(w.id));
    expect(inputOf(w.id, opening.id)?.deliveredAt).toBeUndefined();
  });

  it('flushes held messages that did not fit the answer bundle into the answering turn (#505 local review)', async () => {
    vi.stubEnv('CEZ_MOCK_STEER_MS', '4000');
    const p = await parent('mock:cezar-ask');
    await until(() => store.eventLog.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const send = conversation(p.id);
    const big = (label: string) => `${label} ${'x'.repeat(60_000)}`;
    const held = [send(w.id, p.id, 'progress', big('first')), send(w.id, p.id, 'progress', big('second'))];
    manager.deliverConversationInput(p.id);
    const seq = store.eventLog.readEvents(p.id).at(-1)!.seq;
    // The answer opens a long turn; only the first message fits its bundle.
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'mock:steer-tool answer' }])).toBe(true);
    await until(() => !!inputOf(p.id, held[1]!.id)?.deliveredAt);
    expect(store.eventLog.readEvents(p.id).some(event => event.seq > seq && event.type === 'turn-end'), timeline(p.id, seq)).toBe(false);
  });
});
