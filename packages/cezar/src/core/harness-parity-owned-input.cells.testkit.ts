import '../built-in-run-slots.testkit.ts';
import { describeHarnessPart, type HarnessPartScope, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { ownedInputGroups, type OwnedInputCells } from './harness-parity-owned-input.rows.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { agentInputEventSchema } from '@open-mercato/cezar-contract/events';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { historyPaths } from '../runs/history-file.ts';
import { blockRunWrites, hasPendingAsk, muteLockedDatabaseLogs } from '../runs/run-store.testkit.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { inputDeliveryOf } from './agent-runner-values.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { withOwnedInputRun } from './worker-parity-core.testkit.ts';

export const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString(),
});

const OWNED_INPUT_CELLS: OwnedInputCells = {
  R6: backend => async () => {
    await withOwnedInputRun(backend, 'ask', async ({ store, manager, repoRoot, runId, parentRunId, answer }) => {
      // A real registry entry must NOT expand agent-originated slash text.
      const skills = join(repoRoot, '.ai/cezar/skills');
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, 'owned-skill.md'), '---\nname: owned-skill\n---\nEXPANDED HUMAN SKILL');
      const first = agentInput(parentRunId);
      const second = agentInput(parentRunId, 'mock:agent-echo second steering');
      expect(manager.steerWorker(runId, first)).toBe('queued');
      expect(store.getRun(runId)?.agentInputs).toEqual([first]);
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'ask.requested'));
      const askSeq = store.eventLog.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
      const session = [...fixtureWork(manager).liveSessions].find(live => live.open)!;
      const offered = vi.spyOn(session, 'sendAgentMessage');
      expect(manager.steerWorker(runId, second)).toBe('queued');
      expect(store.getRun(runId)?.status).toBe('waiting');
      // #505: input queued before the session opened steers into the opening turn on a
      // `steer` runner. A `boundary` runner holds it to the turn end, where the question is
      // already pending: the parent's instruction is no message beside it, so it waits for the
      // answer, on a native ask and on cezar_ask alike (hearsay-tools/squawk#2444).
      const steer = inputDeliveryOf(await runnersUnderTest()(backend)).mode === 'steer';
      const delivered = (id: string) => !!store.getRun(runId)?.agentInputs?.find(input => input.id === id)?.deliveredAt;
      // The opening turn's acknowledgement records the delivery.
      if (steer) await waitFor(() => delivered(first.id));
      else expect(delivered(first.id)).toBe(false);
      // Input accepted while the question is pending never reaches the session before the answer.
      // Each flush offers input synchronously: in steerWorker, or in the handler that recorded
      // the first input's delivery. Neither offered the second input to the session at the ask.
      const offers = offered.mock.calls.filter(call => JSON.stringify(call[0]).includes('second steering'));
      offered.mockRestore();
      expect(offers).toEqual([]);
      expect(delivered(second.id)).toBe(false);
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([]);
      const attributed = store.eventLog.readEvents(runId).filter(e => e.type === 'agent-input').map(e => agentInputEventSchema.parse(e).input);
      expect(attributed).toEqual([first, second]);
      const reply = await answer('Vitest');
      await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('second steering')));
      const texts = store.eventLog.readEvents(runId).filter(e => e.type === 'text').map(e => e.text).join('\n');
      expect(texts).toContain(first.text);
      expect(texts).not.toContain('EXPANDED HUMAN SKILL');
      // The parent's reply answers it through the answer seam; no human message is shown.
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      expect(store.getRun(runId)?.agentInputs?.map(input => input.id)).toEqual([first.id, second.id, reply]);
      // The answer retired this ask; the answered turn's end may raise Squawk's fallback question
      // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
      expect(store.transcriptFacts.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ askSeq, source: 'parent' })]);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const afterAsk = agentInput(parentRunId, 'mock:agent-echo after ask');
      expect(manager.steerWorker(runId, afterAsk)).toBe('queued');
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(input => input.id === afterAsk.id)?.deliveredAt);
    });
  },
  R131: backend => async () => {
    await withOwnedInputRun(backend, 'cezar-ask', async ({ store, manager, runId, parentRunId, answer }) => {
      const held = agentInput(parentRunId, 'mock:agent-echo held behind the question');
      const offers: { answered: boolean }[] = [];
      const answeredYet = () => store.eventLog.readEvents(runId).some(e => e.type === 'human-input-delivered');
      const commitWait = store.commitWait.bind(store);
      let steered: ReturnType<typeof manager.steerWorker> | undefined;
      // Mid-turn: the question's wait is open, its card not shown yet, and the turn not ended.
      vi.spyOn(store, 'commitWait').mockImplementation((...args: Parameters<typeof store.commitWait>) => {
        const result = commitWait(...args);
        const [id, wait] = args;
        if (steered === undefined && id === runId && wait.kind === WAIT_KIND.human && wait.via === WAIT_VIA.cezar_ask && wait.phase === WAIT_PHASE.open) {
          for (const session of fixtureWork(manager).liveSessions) {
            const send = session.sendAgentMessage.bind(session);
            vi.spyOn(session, 'sendAgentMessage').mockImplementation((content, inputIds) => {
              if (inputIds?.includes(held.id)) offers.push({ answered: answeredYet() });
              return send(content, inputIds);
            });
          }
          steered = manager.steerWorker(runId, held);
        }
        return result;
      });
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'ask.requested') && store.getRun(runId)?.status === 'waiting');
      const delivered = () => !!store.getRun(runId)?.agentInputs?.find(input => input.id === held.id)?.deliveredAt;
      expect(steered).toBe('queued');
      expect(offers).toEqual([]);
      expect(delivered()).toBe(false);
      await answer('Vitest');
      await waitFor(delivered);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('held behind the question')));
      expect(offers.length).toBeGreaterThan(0);
      expect(offers.every(offer => offer.answered)).toBe(true);
    });
  },
  R7: backend => async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      const { runId, parentRunId } = fixture;
      fixture.manager.enqueueOwnedRun(runId);
      await waitFor(() => fixture.store.eventLog.readEvents(runId).some(e => e.type === 'ask.requested'));
      const input = agentInput(parentRunId);
      expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
      const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
      let recovered: Awaited<ReturnType<typeof fixture.restart>>;
      try {
        recovered = await fixture.restart(dataDir => {
          for (const id of [parentRunId, runId]) rmSync(historyPaths(dataDir, id).facts, { force: true });
          joins.mockClear();
        });
        expect(joins).not.toHaveBeenCalled();
      } finally { joins.mockRestore(); }
      const { store, manager } = recovered!;
      expect(store.getRun(runId)?.status).toBe('waiting');
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      // Neither a bare Continue nor a human answer drains it: the question is the parent's.
      expect(manager.continueRun(runId).ok).toBe(false);
      expect(manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(false);
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      await fixture.answer('Vitest');
      await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('parent steering')));
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      // Restarted answers are acknowledged at opening turn completion, after streamed text.
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'human-input-delivered'));
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ source: 'parent' })]);
    });
  },
  refusedAnswer: backend => async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      const { manager, store, runId, parentRunId } = fixture;
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'ask.requested'));
      const askSeq = store.eventLog.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
      await waitFor(() => store.transcriptFacts.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined && store.getRun(runId)?.status === 'waiting');
      const session = [...fixtureWork(manager).liveSessions][0]!;
      // The session refuses the parent's answer once: it stays queued, and the ask stays pending.
      const refuse = vi.spyOn(session, 'sendMessage').mockReturnValue(false);
      const reply = await fixture.answer('refused answer');
      await waitFor(() => refuse.mock.calls.length > 0 || !!store.getRun(runId)?.agentInputs?.find(entry => entry.id === reply)?.deliveredAt);
      refuse.mockRestore();
      expect(store.getRun(runId)?.agentInputs?.find(entry => entry.id === reply)?.deliveredAt).toBeUndefined();
      expect(store.transcriptFacts.transcriptFacts(runId).pendingAsk?.seq).toBe(askSeq);
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([]);
      expect(hasPendingAsk(store, runId)).toBe(true);
      const input = agentInput(parentRunId);
      expect(manager.steerWorker(runId, input)).toBe('queued');
      const recovered = await fixture.restart();
      // Recovery delivers the parent's accepted answer; no human answers it.
      expect(recovered.manager.continueRun(runId).ok).toBe(false);
      expect(recovered.store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      await waitFor(() => !!recovered.store.getRun(runId)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt);
      // #505: input can land mid-turn, so delivery no longer implies the answering turn
      // ended; the answer's durable checkpoint is still that turn's end.
      await waitFor(() => recovered.store.eventLog.readEvents(runId).some(e => e.type === 'human-input-delivered'));
      expect(recovered.store.eventLog.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ askSeq, source: 'parent' })]);
      // The answer retired this ask; the answered turn's end may raise Squawk's fallback question
      // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
      expect(recovered.store.transcriptFacts.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
    });
  },
  R10: backend => async () => {
    for (const stop of ['finish', 'cancel', 'destroy'] as const) {
      await withOwnedInputRun(backend, 'cezar-done', async ({ store, manager, runId, parentRunId }) => {
        const accepted = agentInput(parentRunId, 'mock:hold');
        expect(manager.steerWorker(runId, accepted)).toBe('queued');
        manager.enqueueOwnedRun(runId);
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
        const pending = agentInput(parentRunId);
        expect(manager.steerWorker(runId, pending)).toBe('queued');
        if (stop === 'destroy') {
          const delegation = store.getRun(runId)!.delegation!;
          if (delegation.role !== 'worker') throw new Error('expected worker');
          store.commitDelegation([{ id: runId, delegation: { ...delegation,
            destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process', 'worktree', 'branch'] },
          } }]);
          expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
        }
        if (stop === 'cancel') manager.cancel(runId);
        else manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
        expect(['review', 'done', 'cancelled']).toContain(store.getRun(runId)?.status);
        expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      });
    }
  },
  R11: backend => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, repoRoot, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      // The idle worker parks on Squawk's fallback question, routed to its parent
      // (hearsay-tools/cezarion#1301, hearsay-tools/cezarion#2410).
      await waitFor(() => store.getRun(runId)?.status === 'waiting' && store.transcriptFacts.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
      store.persistence.flush();
      let unblock: (() => void) | undefined;
      // The input supersedes that question with a write to the parent's conversation first; the
      // failure this cell injects is the input's own delivery checkpoint, after it.
      const failAfterEnqueue = ({ event }: { event: { type: string; reason?: unknown } }) => {
        if (event.type === 'human-ask-closed' && event.reason === 'superseded') unblock ??= blockRunWrites(join(repoRoot, '.ai/cezar'));
      };
      const stopFailAfterEnqueue = store.lifecycle.subscribe({ 'run.event': failAfterEnqueue });
      const input = agentInput(parentRunId, 'mock:hold');
      const unmute = muteLockedDatabaseLogs();
      try {
        expect(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => store.eventLog.readEvents(runId).some(event => event.type === 'error' && String(event.message).includes('agent input delivery checkpoint failed')));
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      } finally {
        stopFailAfterEnqueue();
        unblock?.();
        unmute();
      }
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
    });
  },
  R9: backend => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId, answer }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      // The idle worker's park may already be Squawk's fallback question (hearsay-tools/cezarion#1301):
      // wait for the continuation's own ask.
      const asked = store.eventLog.readEvents(runId).filter(e => e.type === 'ask.requested').length;
      expect(manager.continueRun(runId, { text: promptFor(backend, 'ask-reply-late') }).ok).toBe(true);
      await waitFor(() => store.eventLog.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
      const input = agentInput(parentRunId);
      expect(manager.steerWorker(runId, input)).toBe('queued');
      // The continuation's ask is the worker's own: its parent answers it (hearsay-tools/cezarion#2410).
      await answer('Vitest');
      await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text))
        .toEqual([promptFor(backend, 'ask-reply-late')]);
    });
  },
  R8: backend => async () => {
    await withOwnedInputRun(backend, 'hold', async fixture => {
      const { runId, parentRunId, repoRoot } = fixture;
      fixture.store.persistence.flush();
      const unblock = blockRunWrites(join(repoRoot, '.ai/cezar'));
      try {
        expect(() => fixture.manager.steerWorker(runId, agentInput(parentRunId))).toThrow();
        expect(fixture.store.getRun(runId)?.agentInputs).toBeUndefined();
        expect(fixture.store.eventLog.readEvents(runId).filter(e => e.type === 'agent-input')).toEqual([]);
      } finally { unblock(); }
      const input = agentInput(parentRunId);
      expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
      const { store, manager } = await fixture.restart();
      const second = agentInput(parentRunId, 'mock:agent-echo during startup');
      expect(manager.steerWorker(runId, second)).toBe('queued');
      await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('during startup')));
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
    });
  },
  durableOpeningAnswer: (backend, outcome) => async () => {
    await withOwnedInputRun(backend, 'ask', async fixture => {
      const { runId, parentRunId } = fixture;
      fixture.manager.enqueueOwnedRun(runId);
      await waitFor(() => fixture.store.transcriptFacts.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
      const input = agentInput(parentRunId);
      expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
      const { store, manager } = await fixture.restart();
      const before = store.eventLog.readEvents(runId).at(-1)!.seq;
      // The parent's answer reopens the closed session as its opening input (hearsay-tools/cezarion#2410).
      const reply = await fixture.answer(outcome === 'rejected' ? 'mock:reject-agent-post' : 'mock:hold');
      // The reopened session waits for capacity, so it may not have started yet.
      await waitFor(() => manager.isActive(runId) || store.getRun(runId)?.status === 'failed');
      if (outcome !== 'rejected') {
        await waitFor(() => store.eventLog.readEvents(runId).some(e => e.seq > before && e.type === 'turn.started'));
        if (outcome === 'finished') expect(manager.finish(runId)).toBe(true);
        else manager.cancel(runId);
      }
      await waitFor(() => !manager.isActive(runId));
      const events = store.eventLog.readEvents(runId).filter(e => e.seq > before);
      if (outcome === 'rejected') {
        // A parent's rejected answer stays queued for another try, so the worker waits.
        expect(store.getRun(runId)?.status).toBe('waiting');
        expect(events.filter(e => e.type === 'error')).toHaveLength(1);
        expect(events.findIndex(e => e.type === 'error')).toBeLessThan(events.findIndex(e => e.type === 'turn-end'));
      }
      expect(events.filter(e => e.type === 'human-input-delivered')).toEqual([]);
      // #505: the queued message steers into the answering turn right behind the answer,
      // so it may carry a delivery receipt; the input itself is unchanged and never lost.
      const withoutReceipts = (inputs: AgentInput[] | undefined) => inputs?.filter(entry => entry.id !== reply).map(({ deliveredAt: _d, consumedAt: _c, awaitingRead: _a, ...rest }) => rest);
      expect(withoutReceipts(store.getRun(runId)?.agentInputs)).toEqual([input]);
      // hearsay-tools/cezarion#1260: Finish closes the question it never saw answered, without a
      // delivery. A Stop closes it with the worker (hearsay-tools/cezarion#2410). A rejected answer
      // leaves it for another answer.
      const askSeq = store.eventLog.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
      const closed = { finished: 'finish', cancelled: 'worker-stopped', rejected: undefined }[outcome];
      expect(events.filter(e => e.type === 'human-ask-closed')).toEqual(closed ? [expect.objectContaining({ askSeq, reason: closed })] : []);
      const recovered = await fixture.restart();
      expect(hasPendingAsk(recovered.store, runId)).toBe(outcome === 'rejected');
      if (outcome === 'rejected') expect(recovered.manager.continueRun(runId).ok).toBe(false);
      expect(withoutReceipts(recovered.store.getRun(runId)?.agentInputs)).toEqual([input]);
    });
  },
  durableLateReplyDone: (backend, mode) => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId, answer }) => {
      const prompt = 'mock:ask-reply-late-cezar-done';
      if (mode === 'fresh') store.updateRun(runId, { task: prompt });
      manager.enqueueOwnedRun(runId);
      let asked = 0;
      if (mode === 'continuation') {
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        // The idle worker's park may already be Squawk's fallback question (hearsay-tools/cezarion#1301).
        asked = store.eventLog.readEvents(runId).filter(e => e.type === 'ask.requested').length;
        expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      }
      await waitFor(() => store.eventLog.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
      const input = agentInput(parentRunId);
      expect(manager.steerWorker(runId, input)).toBe('queued');
      await answer('Vitest');
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
      expect(manager.isActive(runId)).toBe(true);
    });
  },
  durableRejectedHumanPost: backend => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:reject-agent-post' }])).toBe(true);
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('prompt failed')));
      expect(store.eventLog.readEvents(runId).filter(e => e.type === 'error')).toEqual([]);
      expect(manager.isActive(runId)).toBe(true);
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      expect(['done', 'review']).toContain(store.getRun(runId)?.status);
    });
  },
  durableRejectedAgentPost: (backend, mode) => async () => {
    await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      if (mode === 'continuation') {
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
        await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
      }
      const rejected = agentInput(parentRunId, 'mock:reject-agent-post');
      expect(manager.steerWorker(runId, rejected)).toBe('queued');
      const pending = agentInput(parentRunId);
      expect(manager.steerWorker(runId, pending)).toBe('queued');
      await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'error'));
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      expect(store.getRun(runId)?.error).toContain('agent input failed');
      expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
    });
  },
};

export const OWNED_INPUT_GROUPS = ownedInputGroups(OWNED_INPUT_CELLS);

/** Register the owned-input part's cells for one runner: `harness-<runner>-owned-input-parity.test.ts`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('owned-input', OWNED_INPUT_GROUPS, scope, registration);
}
