import { runnerDefinition } from './runner-registry.ts';
import { exemptionFor } from './harness-parity-core.testkit.ts';
import { assertPromptResponseCompletion } from './owned-input-delivery.testkit.ts';
/**
 * A15: an autonomous nudge whose acknowledgement never arrives is bounded at the no-wait nudge's
 * reply bound. At expiry the run notes the unanswered nudge, closes its session through the idle
 * path and settles `waiting`, with no human wait (hearsay-tools/squawk#2443).
 *
 * The mock withholds the nudge's transport acknowledgement (`hold-ack`). Where the turn's frames
 * still reach the runner (Codex, OpenCode, Pi, OMP), the nudge's reply turn ends with its
 * acknowledgement still outstanding, so the turn end defers to it and the bound runs from there.
 * Claude acknowledges at its own stdin write: its cell is the inverted assertion, where every
 * acknowledgement cancels its bound and the run continues to the cap.
 */
import { expect, vi } from 'vitest';
import { STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { testHome } from '../home/test-home.testkit.ts';
import * as activeRuns from '../workflows/active-run.ts';
import { MAX_AUTO_CONTINUES, NO_WAIT_NUDGE_REPLY_MS } from '../workflows/run.ts';
import { AUTONOMOUS_NO_ACK_NOTE, AUTONOMOUS_NUDGE } from '../workflows/turn-end.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

import { waitFor } from './harness-parity-core.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { withHeldAck } from './owned-input-delivery.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';

/** The step bound of each wait in the cell; the run's own signals end every wait. */
const STEP_MS = 20_000;

type Fixture = { store: RunStore; manager: RunManager; runId: string };
type Cell = { semaphore: WorkspaceSemaphore; clock: () => ReturnType<typeof observationClock>; state: () => activeRuns.ActiveRun };

const notesOf = (store: RunStore, runId: string, text: string) =>
  store.eventLog.readEvents(runId).filter(e => e.type === 'note' && String(e.message).includes(text));

/** The held row: the bound is armed while the nudge waits for its acknowledgement, the run keeps
 *  running until it expires, then it notes the nudge and settles `waiting` once the process exits.
 *  Where the wire still runs the nudge's turn (`replies`), its activity stops the bound, and the turn
 *  end that finds the acknowledgement missing arms it again. */
async function assertBoundCloses({ store, manager, runId }: Fixture, cell: Cell): Promise<void> {
  const nudged = () => store.eventLog.readEvents(runId).findIndex(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));
  const replied = () => nudged() >= 0 && store.eventLog.readEvents(runId).slice(nudged()).some(e => e.type === 'text');
  await waitFor(() => nudged() >= 0 && replied() && cell.clock().pending > 0, STEP_MS);
  // One bound at the submission; a reply stopped it and its turn end armed a second.
  expect(cell.clock().captured).toBe(2);
  const state = cell.state();
  const session = state.liveSession.session!;
  expect(state.boundary.nudge).toEqual({ session, cause: 'autonomous', state: 'submitted', answered: true });
  expect(store.getRun(runId)?.status).toBe('running');
  expect(cell.semaphore.busy()).toBe(1);
  await cell.clock().advance(NO_WAIT_NUDGE_REPLY_MS);
  expect(notesOf(store, runId, AUTONOMOUS_NO_ACK_NOTE)).toHaveLength(1);
  await waitFor(() => !manager.isActive(runId), STEP_MS);
  expect(cell.semaphore.busy()).toBe(0);
  expect(store.getRun(runId)?.status).toBe('waiting');
  expect(store.getRun(runId)?.steps.at(-1)?.status).toBe(STEP_STATUS.waiting);
  // The idle path asks nothing of the user.
  expect(store.getRun(runId)?.waits ?? []).toEqual([]);
  expect(notesOf(store, runId, 'continuing without pausing')).toHaveLength(1);
}

/** The inverted row: each acknowledgement cancels its bound, so the run continues to the cap. */
async function assertAcknowledged({ store, runId }: Fixture, cell: Cell): Promise<void> {
  await waitFor(() => store.getRun(runId)?.status === 'waiting', STEP_MS);
  expect(notesOf(store, runId, 'continuing without pausing')).toHaveLength(MAX_AUTO_CONTINUES);
  expect(cell.clock().captured).toBeGreaterThanOrEqual(MAX_AUTO_CONTINUES);
  expect(cell.clock().pending).toBe(0);
  expect(notesOf(store, runId, AUTONOMOUS_NO_ACK_NOTE)).toEqual([]);
}

/** Drive A15 on `backend`. `heldAck` is false on a wire whose acknowledgement is its own write. */
export async function unacknowledgedNudgeBound(backend: string, { heldAck }: { heldAck: boolean }): Promise<void> {
  const exemption = exemptionFor('A15', backend);
  if (exemption && runnerDefinition(backend).mock.promptResponseEndsTurn) {
    expect(exemption.kind).toBe('capability-absent');
    await assertPromptResponseCompletion(backend); return;
  }
  const semaphore = new WorkspaceSemaphore({ home: testHome() });
  const states: activeRuns.ActiveRun[] = [];
  const create = activeRuns.createActiveRun;
  const created = vi.spyOn(activeRuns, 'createActiveRun').mockImplementation(init => {
    const state = create(init);
    states.push(state);
    return state;
  });
  let clock: ReturnType<typeof observationClock> | undefined;
  const cell: Cell = { semaphore, clock: () => clock!, state: () => states.at(-1)! };
  let finished = false;
  const drive = (releaseAck: () => void) => driveRun(backend, 'autonomous-cap', () => finished, 60_000, undefined, {
    semaphore, autonomous: true,
    // Only the nudge's bound is frozen; native processes keep real time.
    beforeStart: () => { clock = observationClock(delay => delay === NO_WAIT_NUDGE_REPLY_MS && /armAutonomousNudgeBound/.test(new Error().stack ?? '')); },
    beforeCleanup: () => { clock?.restore(); releaseAck(); },
    during: async fixture => {
      if (heldAck) await assertBoundCloses(fixture, cell);
      else await assertAcknowledged(fixture, cell);
      finished = true;
    },
  });
  try {
    if (heldAck) await withHeldAck(backend, async release => { await drive(release); }, AUTONOMOUS_NUDGE.slice(0, 63));
    else await drive(() => {});
  } finally {
    created.mockRestore();
  }
}
