import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract/conversations';
import { conversationSendResultSchema } from '@open-mercato/cezar-contract/conversations';
import { discoveredTasksSchema } from '@open-mercato/cezar-contract/discovery';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { conversationOf } from '../runs/task-rights.ts';
import { fixture } from './service-engine.testkit.ts';

sealTestRunners(claudeRunner);

// Send results and `message tasks` report the caller's family ledger load, and warn at 75 % of a
// bound (hearsay-tools/squawk#4192).
describe('conversation capacity headroom', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => {
    for (const run of f.store.queries.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks();
  });
  const progress = (count: number, senderRunId: string, recipientRunId: string): ConversationMessage[] => Array.from({ length: count }, (_, n) =>
    ({ id: randomUUID(), senderRunId, recipientRunId, kind: 'progress', text: `m${n}`, createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' }));
  function seed(messages: ConversationMessage[]): void {
    const state = conversationOf(f.store.getRun(f.parent.id)) ?? { messages: [], outcomes: [] };
    f.store.commitConversation(f.parent.id, { ...state, messages: [...state.messages, ...messages] });
  }
  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    setRunStatus(f.store, workerId, RUN_STATUS.running);
    return workerId;
  }
  const send = async (recipientRunId: string, kind: 'request' | 'progress') => conversationSendResultSchema.parse(
    await f.service.send(f.caller, { id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600 }));

  it('reports the ledger that took the message and the recipient inbox on a send result', async () => {
    const workerId = await worker();
    const before = conversationOf(f.store.getRun(f.parent.id))?.messages.length ?? 0;
    const result = await send(workerId, 'request');
    const inbox = (f.store.getRun(workerId)?.agentInputs ?? []).filter(input => !input.deliveredAt).length;
    expect(result.capacity).toEqual({ activeMessages: before + 2, activeMessageLimit: 1024, openRequests: 1, openRequestLimit: 32,
      recipientInbox: inbox, inboxLimit: 32 });
  });

  it('warns at 768 active messages and not at 767', async () => {
    const workerId = await worker();
    const before = conversationOf(f.store.getRun(f.parent.id))?.messages.length ?? 0;
    seed(progress(766 - before, f.parent.id, workerId));
    const below = await send(workerId, 'progress');
    expect(below.capacity).toMatchObject({ activeMessages: 767 });
    expect(below.capacity?.warning).toBeUndefined();
    const at = await send(workerId, 'progress');
    expect(at.capacity).toMatchObject({ activeMessages: 768 });
    expect(at.capacity?.warning).toContain('768 of 1024 active messages');
  });

  it('reports the caller ledger in message tasks, with no recipient inbox, and warns at 75 %', async () => {
    const workerId = await worker();
    const discover = async () => discoveredTasksSchema.parse(await f.service.discover(f.caller, { kind: 'tasks' })).capacity;
    const before = conversationOf(f.store.getRun(f.parent.id))?.messages.length ?? 0;
    seed(progress(767 - before, f.parent.id, workerId));
    expect(await discover()).toEqual({ activeMessages: 767, activeMessageLimit: 1024, openRequests: 0, openRequestLimit: 32, inboxLimit: 32 });
    seed(progress(1, f.parent.id, workerId));
    expect((await discover())?.warning).toContain('768 of 1024 active messages');
  });
});
