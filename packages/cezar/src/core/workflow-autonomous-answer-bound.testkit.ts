/**
 * A16: an autonomous nudge the harness acknowledges and then never answers is bounded from its
 * acknowledgement at the no-wait nudge's reply bound. Heartbeats do not extend it. At expiry the
 * run notes the unanswered nudge, closes its session through the idle path and settles `waiting`,
 * with no human wait (hearsay-tools/squawk#3741).
 *
 * The mock's first turn ends with no done. It acknowledges the nudge and sends a heartbeat frame
 * every 50 ms, with no turn and no model work. A shared row: the bound is Squawk's.
 */
import { expect } from 'vitest';
import { setTimeout as realDelay } from 'node:timers/promises';
import { STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { NO_WAIT_NUDGE_REPLY_MS } from '../workflows/run.ts';
import { AUTONOMOUS_NO_ACK_NOTE, AUTONOMOUS_NO_REPLY_NOTE } from '../workflows/turn-end.ts';
import type { RunnerId } from './agent-runner.ts';
import { waitFor } from './harness-parity.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { driveRun } from './workflow-parity.testkit.ts';

/** The step bound of each wait in the cell; the run's own signals end every wait. */
const STEP_MS = 20_000;
/** Real time that lets several of the mock's 50 ms heartbeats reach the runner while the bound is frozen. */
const HEARTBEAT_WINDOW_MS = 300;

/** Drive A16 on `backend`. */
export async function acknowledgedNudgeAnswerBound(backend: RunnerId): Promise<void> {
  const semaphore = new WorkspaceSemaphore({ home: testHome() });
  let clock: ReturnType<typeof observationClock> | undefined;
  let finished = false;
  const notesOf = (events: readonly Record<string, unknown>[], text: string) => events.filter(e => e.type === 'note' && e.message === text);
  await driveRun(backend, 'autonomous-silent', () => finished, 60_000, undefined, {
    semaphore, autonomous: true,
    // Only the answer bound is frozen; the native process keeps real time.
    beforeStart: () => { clock = observationClock(delay => delay === NO_WAIT_NUDGE_REPLY_MS && /armAutonomousNudgeAnswerBound/.test(new Error().stack ?? '')); },
    beforeCleanup: () => { clock?.restore(); },
    during: async ({ store, manager, runId }) => {
      await waitFor(() => clock!.pending === 1, STEP_MS);
      // bound: real time for the heartbeats to flow while the answer bound waits.
      await realDelay(HEARTBEAT_WINDOW_MS);
      expect(clock!.captured).toBe(1);
      expect(clock!.pending).toBe(1);
      expect(store.getRun(runId)?.status).toBe('running');
      expect(semaphore.busy()).toBe(1);
      expect(notesOf(store.readEvents(runId), AUTONOMOUS_NO_REPLY_NOTE)).toEqual([]);
      await clock!.advance(NO_WAIT_NUDGE_REPLY_MS);
      expect(notesOf(store.readEvents(runId), AUTONOMOUS_NO_REPLY_NOTE)).toHaveLength(1);
      expect(notesOf(store.readEvents(runId), AUTONOMOUS_NO_ACK_NOTE)).toEqual([]);
      await waitFor(() => !manager.isActive(runId), STEP_MS);
      expect(semaphore.busy()).toBe(0);
      expect(store.getRun(runId)?.status).toBe('waiting');
      expect(store.getRun(runId)?.steps.at(-1)?.status).toBe(STEP_STATUS.waiting);
      // The idle path asks nothing of the user.
      expect(store.getRun(runId)?.waits ?? []).toEqual([]);
      finished = true;
    },
  });
}
