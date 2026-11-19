import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { enqueueAgentInput } from '../delegation/input.ts';
import { blockedDone, blockingWorker, describeWaitCells, gated, github, nativeWire, parentTurn, pr, prompted } from './waits-parity-fixture.testkit.ts';
import { manager, parent, restart, store, terminal, timeline, until } from './worker-wait-core.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { factsAtDone } from './run/done-accepted.ts';
import { COMPLETION_NUDGE_NOTE, DONE_KEPT_NOTE, DONE_RECONSIDERED_NOTE } from './turn-end.ts';

// hearsay-tools/squawk#2587: what an accepted cezar_done does when input, a wait or a refusal
// follows it (the spec's "Transitions out: hearsay-tools/squawk#2587 (S13)" table). U6r and U6p
// pin the kept done and the refused one on every runner; these rows run on Claude's wire.
useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));
const runner = 'claude';

const prWait = (id: string) => store.getRun(id)?.waits?.find(wait => wait.kind === WAIT_KIND.pr);
const finished = (id: string) => terminal.includes(store.getRun(id)?.status ?? '') && !manager.isActive(id);
const closings = (id: string) => store.readEvents(id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
const withdrawn = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith('cezar_done withdrawn: ')).map(event => event.message);

async function quietRun() {
  nativeWire(runner);
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
  await until(() => store.getRun(run.id)?.status === 'waiting');
  return run;
}

async function waitingOnPr() {
  const run = await quietRun();
  await parentTurn(run.id, toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr }), () => prWait(run.id)?.phase === WAIT_PHASE.open);
  return run;
}

/** The done is withdrawn for `reason`: the input still reached the agent, with the withdrawal note,
 *  and the run did not finish: its quiet turn ends ask the user. */
async function expectWithdrawn(id: string, delivered: string, reason: string) {
  await until(() => prompted(runner, delivered).length > 0 && gated(id), () => timeline(id));
  expect(prompted(runner, delivered).some(prompt => prompt.includes(DONE_RECONSIDERED_NOTE))).toBe(true);
  expect(store.getRun(id)?.doneAccepted).toBeUndefined();
  expect(withdrawn(id)).toEqual([`cezar_done withdrawn: ${reason}`]);
  expect(closings(id)).toEqual([]);
}

describeWaitCells(() => {
  it('a failed wait result after an accepted done withdraws it and is still delivered', async () => {
    const external = github();
    const run = await waitingOnPr();
    await blockedDone(run.id, async () => {
      external.settle('failed');
      await until(() => prWait(run.id)?.phase === WAIT_PHASE.resolved);
    });
    await expectWithdrawn(run.id, 'CI wait observation', 'a failed pr wait result');
    expect(store.getRun(run.id)?.lastWaits?.find(wait => wait.kind === WAIT_KIND.pr)).toMatchObject({ phase: WAIT_PHASE.delivered });
  });

  it('a human message after an accepted done withdraws it and is still delivered', async () => {
    const run = await quietRun();
    const text = 'One more change, please.';
    await blockedDone(run.id, () => { expect(manager.sendMessage(run.id, [{ type: 'text', text }])).toBe(true); });
    await expectWithdrawn(run.id, text, 'a new human message');
  });

  it('an agent request after an accepted done withdraws it and is still delivered', async () => {
    const run = await quietRun();
    const text = 'Please also update the changelog.';
    await blockedDone(run.id, () => {
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: run.id, text, createdAt: new Date().toISOString(),
        conversation: { senderRunId: randomUUID(), recipientRunId: run.id, kind: 'request' as const } };
      store.commitAgentInputs(run.id, enqueueAgentInput(store.getRun(run.id)!, input));
      manager.deliverConversationInput(run.id);
    });
    await expectWithdrawn(run.id, text, 'a new agent request');
  });

  it('a wait the agent registers after an accepted done withdraws it, and the run parks on the wait', async () => {
    const run = await quietRun();
    const timer = () => store.getRun(run.id)?.waits?.find(wait => wait.kind === WAIT_KIND.timer && wait.phase === WAIT_PHASE.open);
    await parentTurn(run.id, `${toolCall('cezar_done', {})} ${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'later' })}`, () => !!timer());
    expect(store.getRun(run.id)?.doneAccepted).toBeUndefined();
    expect(withdrawn(run.id)).toEqual(['cezar_done withdrawn: the agent registered a wait']);
    expect(closings(run.id)).toEqual([]);
  });

  // D2: a registration the tool replays (the same operation_id) registers nothing new.
  it('a replayed wait registration after an accepted done keeps the done, and the run finishes', async () => {
    const run = await quietRun();
    const register = toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'd2', operation_id: randomUUID() });
    const timer = () => store.getRun(run.id)?.waits?.find(wait => wait.kind === WAIT_KIND.timer);
    await parentTurn(run.id, register, () => timer()?.phase === WAIT_PHASE.open);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${register}` }])).toBe(true);
    await until(() => finished(run.id), () => timeline(run.id));
    expect(withdrawn(run.id)).toEqual([]);
    expect(closings(run.id)).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
  });

  it('a done committed before a restart finishes the run at the next turn end with no new wait or ask', async () => {
    const external = github();
    const run = await waitingOnPr();
    // What a crash right after the tool accepted the done leaves: the record, and the wait it outranks.
    store.commitOutcome(run.id, { kind: 'done-accepted', done: { session: 'before-restart', at: new Date().toISOString(), seq: store.transcriptFacts(run.id).lastSeq, ...factsAtDone(store.getRun(run.id)!) } });
    await restart();
    external.settle();
    await until(() => finished(run.id), () => timeline(run.id));
    expect(prompted(runner, DONE_KEPT_NOTE)).toHaveLength(1);
    expect(closings(run.id)).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
    expect(store.getRun(run.id)?.doneAccepted).toBeUndefined();
  });

  it('a completion refusal at the turn end withdraws the accepted done, and the worker still blocks it', async () => {
    nativeWire(runner);
    const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    await blockedDone(p.id, () => blockingWorker(p.id));
    await until(() => withdrawn(p.id).length > 0, () => timeline(p.id));
    expect(withdrawn(p.id)).toEqual(['cezar_done withdrawn: completion refused: workers_outstanding']);
    expect(store.getRun(p.id)?.doneAccepted).toBeUndefined();
    await until(() => store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)), () => timeline(p.id));
    expect(closings(p.id)).toEqual([]);
    expect(terminal).not.toContain(store.getRun(p.id)?.status);
  });
});
