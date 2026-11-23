import '../built-in-wait-kinds.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { workflowAutonomousParity } from './workflow-autonomous-rows.testkit.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { randomUUID } from 'node:crypto';
import { expect, onTestFinished, vi } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { driveSeam, promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { withOwnedInputRun } from './workflow-parity-core.testkit.ts';
import { refusedNudgeIdleClose } from './workflow-autonomous-idle-close.testkit.ts';
import { unacknowledgedNudgeBound } from './workflow-autonomous-ack-bound.testkit.ts';
import { acknowledgedNudgeAnswerBound } from './workflow-autonomous-answer-bound.testkit.ts';
import { MAX_AUTO_CONTINUES } from '../workflows/run.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { RUN_EXITS } from '../runs/run-exits.ts';
import { askErrorMessage } from '../ci-wait/errors.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { onRunWrite } from '../runs/lifecycle-listeners.testkit.ts';

// The settle budget for the row cells below. OpenCode's A5, A11 and A12 cells run
// MAX_AUTO_CONTINUES turns and take 4.6-4.8 s alone and 5.4-5.9 s in an idle full
// `npm test` (measured 2026-10-07); a loaded full suite pushed them past waitFor's
// 10 s default (hearsay-tools/cezarion#873).
//
// The cap rows (A5, A11, A12) run MAX_AUTO_CONTINUES + 1 SEQUENTIAL turns, so their
// cost is per turn times turns, not one bound: on a loaded host the whole row outgrew
// one fixed wait (hearsay-tools/cezarion#1125). So the settle wait bounds the gap
// between turns, not the whole row: each nudge resets the window, and a nudge that
// never lands (an autonomous run stuck between turns) still fails within
// ROW_SETTLE_MS of the last one.
const ROW_SETTLE_MS = 25_000;
// The cell timeout for the cap rows grants each of their turns a budget instead.
// 2 s was sized at about six times the idle per-turn cost of a runner that spawned a
// fresh process every turn (about 340 ms between nudges, measured 2026-10-16 at load 5
// on 24 cores). Every remaining runner keeps one process across turns.
const CAP_TURN_BUDGET_MS = 2_000;
const CAP_ROW_TIMEOUT_MS = 30_000 + (MAX_AUTO_CONTINUES + 1) * CAP_TURN_BUDGET_MS;

/** waitFor whose deadline restarts whenever `progress` changes value. */
async function waitForProgressing(cond: () => boolean, progress: () => unknown, stallMs: number): Promise<void> {
  let last = progress();
  let since = Date.now();
  // bound: the deadline restarts whenever progress changes, so the loop ends once nothing has changed for stallMs.
  while (!cond()) {
    const now = progress();
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since > stallMs) throw new Error(`waitFor timed out: no progress for ${stallMs} ms (last: ${String(last)})`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const nudges = (events: readonly Record<string, unknown>[]) => events.filter(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));

export const describeWorkflowAutonomousParity = workflowAutonomousParity({
  idleClose: (backend, row, options) => () => refusedNudgeIdleClose(backend, row.id === 'A14', options),
  answerBound: backend => () => acknowledgedNudgeAnswerBound(backend),
  ackBound: (backend, exemption) => () => unacknowledgedNudgeBound(backend, { heldAck: !exemption }),
  exemption: backend => async () => {
    // The wire's ask scenario is a cezar_ask call, which no seam answers: the turn ends with no
    // native ask.requested. A native mid-turn ask on this wire fails the first line.
    const observed = await driveSeam(backend, 'ask');
    expect(observed.v2.some(e => e.type === 'ask.requested')).toBe(false);
    expect(observed.v1.some(e => e.type === 'turn-end')).toBe(true);
  },
  row: (backend, row, mode) => async () => {
    const scenario = row.id === 'A9' ? runnerDefinition(backend).mock.nativeAskScenario ?? row.scenario : row.scenario;
    await withOwnedInputRun(backend, mode === 'continuation' ? 'autonomous' : scenario, async ({ store, manager, runId }) => {
      async function prepareContinuation(): Promise<void> {
        if (mode === 'continuation') {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.getRun(runId)?.status === 'waiting', ROW_SETTLE_MS);
          manager.finish(runId);
          await waitFor(() => !manager.isActive(runId), ROW_SETTLE_MS);
        }
      }
      await prepareContinuation();
      store.updateRun(runId, { autonomous: row.id !== 'A6' });
      if (row.id === 'A10') store.eventLog.appendEvent(runId, {
        type: 'ask.requested', requestId: randomUUID(),
        questions: [{ header: 'Prior', question: 'A prior unanswered question?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      });
      // Every status write applies a run exit through the store's move (ADR 0056).
      const moves = vi.spyOn(store, 'move');
      const statusWrites = () => moves.mock.calls.filter(([id]) => id === runId).map(([, exit]) => RUN_EXITS[exit].to);
      const priorHumanWaits = new Set((store.getRun(runId)?.waits ?? []).filter(wait => wait.kind === WAIT_KIND.human).map(wait => wait.id));
      const publishedHumanWaits = new Set<string>();
      const observeHumanWaits = (run: RunRecord) => {
        if (run.id !== runId) return;
        for (const wait of run.waits ?? []) {
          if (wait.kind === WAIT_KIND.human && wait.phase === WAIT_PHASE.open && !priorHumanWaits.has(wait.id)) publishedHumanWaits.add(wait.id);
        }
      };
      const stopObserveHumanWaits = onRunWrite(store.lifecycle, observeHumanWaits);
      onTestFinished(() => { stopObserveHumanWaits(); });
      // A refused cezar_ask answers the agent and leaves no run event; the registry's warning is its trace.
      const warnings = vi.spyOn(console, 'warn');
      const askRefusals = () => warnings.mock.calls.filter(([message]) => String(message).includes('wait registration refused: autonomous_run')).length;
      const startSeq = store.eventLog.readEvents(runId).length;
      // A native ask parks mid-turn, and nothing may answer it on the wire. Every write to a
      // session this run opens after the ask is recorded, so a synthetic answer shows when it is
      // sent, without waiting for the wire to react to it.
      const writesAfterAsk: string[] = [];
      if (row.id === 'A9') {
        const work = fixtureWork(manager);
        const track = work.trackSession.bind(work);
        const tracked = vi.spyOn(work, 'trackSession').mockImplementation(((session, closed) => {
          for (const method of ['sendMessage', 'sendAgentMessage', 'respondPermission'] as const) {
            const original = session[method] as ((...args: unknown[]) => unknown) | undefined;
            if (!original) continue;
            Object.assign(session, { [method]: (...args: unknown[]) => {
              if (store.eventLog.readEvents(runId).slice(startSeq).some(e => e.type === 'ask.requested')) writesAfterAsk.push(method);
              return original.apply(session, args);
            } });
          }
          return track(session, closed);
        }) as typeof work.trackSession);
        onTestFinished(() => { tracked.mockRestore(); });
      }
      if (mode === 'continuation') expect(manager.continueRun(runId, { text: promptFor(backend, scenario) }).ok).toBe(true);
      else manager.enqueueOwnedRun(runId);
      // Done rows reach their terminal outcome before we check publication history.
      // Other rows settle at their park. Nudge progress resets the stall bound.
      const expectsDone = ['A1', 'A2', 'A3', 'A4', 'A8'].includes(row.id);
      await waitForProgressing(
        () => {
          return (!expectsDone && store.getRun(runId)?.status === 'waiting') || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? '');
        },
        () => store.getRun(runId)?.automaticWakes,
        ROW_SETTLE_MS,
      );
      const events = store.eventLog.readEvents(runId).slice(startSeq);
      const notes = nudges(events);
      function assertCapOutcome(): void {
        expect(store.getRun(runId)?.status).toBe('waiting');
        expect(notes).toHaveLength(MAX_AUTO_CONTINUES);
        expect(statusWrites().filter(status => status === RUN_STATUS.waiting)).toHaveLength(1);
        expect(events.filter(e => e.type === 'note' && String(e.message).includes(`autonomous — safety cap reached (${MAX_AUTO_CONTINUES})`))).toHaveLength(1);
      }
      function assertParkedOutcome(): void {
        expect(store.getRun(runId)?.status).toBe('waiting');
        expect(notes).toHaveLength(0);
        if (row.id === 'A9') {
          expect(events.some(e => e.type === 'ask.requested')).toBe(true);
          // No synthetic answer reached the wire.
          expect(writesAfterAsk).toEqual([]);
        }
        // The agent's own timer is the run's wake, so no autonomous nudge goes beside it.
        if (row.id === 'A7') expect(store.getRun(runId)?.waits?.filter(wait => wait.kind === WAIT_KIND.timer && wait.phase === WAIT_PHASE.open)).toHaveLength(1);
        if (row.id === 'A10') {
          // The persisted question stays the pending one: the agent's own cezar_ask was refused.
          expect(hasPendingAsk(store, runId)).toBe(true);
          expect(askRefusals()).toBeGreaterThanOrEqual(1);
        }
        if (row.id !== 'A6') expect(events.some(e => e.type === 'human-input-delivered')).toBe(false);
      }
      function assertDoneOutcome(): void {
        expect(store.getRun(runId)?.status).toBe('done');
        expect(notes).toHaveLength(row.id === 'A8' ? 0 : 1);
        expect(statusWrites()).not.toContain(RUN_STATUS.waiting);
        expect([...publishedHumanWaits]).toEqual([]);
        expect(store.getRun(runId)?.waits?.filter(wait => wait.kind === WAIT_KIND.human && wait.phase === WAIT_PHASE.open) ?? []).toEqual([]);
        const stepId = store.getRun(runId)!.steps.at(-1)!.id;
        expect(notes.every(note => note.stepId === stepId)).toBe(true);
        if (row.id === 'A3' || row.id === 'A4') {
          expect(askRefusals()).toBeGreaterThanOrEqual(1);
          // The refusal reaches the agent through its own native wire, which echoes it.
          expect(events.some(e => e.type === 'text' && String(e.text).includes(askErrorMessage('autonomous_run')))).toBe(true);
          expect(events.filter(e => e.type === 'ask.requested' || e.type === 'human-input-delivered')).toEqual([]);
          expect(events.filter(e => e.type === 'user-message' && String(e.text).startsWith('Continue working autonomously'))).toEqual([]);
        }
      }
      if (row.id === 'A5' || row.id === 'A11' || row.id === 'A12') {
        assertCapOutcome();
      } else if (row.id === 'A6' || row.id === 'A7' || row.id === 'A9' || row.id === 'A10') {
        assertParkedOutcome();
      } else {
        assertDoneOutcome();
      }
      if (row.id === 'A11' || row.id === 'A12') {
        expect(askRefusals()).toBeGreaterThanOrEqual(1);
        expect(events.filter(e => e.type === 'ask.requested' || e.type === 'human-input-delivered')).toEqual([]);
        expect(events.filter(e => e.type === 'user-message' && String(e.text).startsWith('Continue working autonomously'))).toEqual([]);
        expect(statusWrites().filter(status => status === RUN_STATUS.waiting)).toHaveLength(1);
      }
      moves.mockRestore();
      warnings.mockRestore();
    });
  },
  capRowTimeoutMs: CAP_ROW_TIMEOUT_MS,
});
