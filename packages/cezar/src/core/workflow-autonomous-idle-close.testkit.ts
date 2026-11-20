/**
 * A13/A14: a refused autonomous nudge keeps its slot until the idle bound, then settles `waiting`
 * after the process exits, fresh (A13) and on a Continue (A14) (hearsay-tools/squawk#2452).
 *
 * The refusal is real. A human follow-up sent while a `hold-gated` turn runs reaches the wire, and
 * the mock withholds its transport acknowledgement (`hold-ack`). Its turn ends with the
 * acknowledgement still outstanding, so a wire that refuses agent input while a prompt is
 * unacknowledged refuses the autonomous nudge at that turn end. An exempt wire admits the nudge
 * there: its cell is the inverted assertion.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { testHome } from '../home/test-home.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import * as activeRuns from '../workflows/active-run.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run.ts';
import type { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { withHeldAck } from './owned-input-delivery.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';

/** The human follow-up whose prompt acknowledgement the mock withholds. */
const HELD_ACK = 'a13-held-human-ack';
// scripts/mock-deferred-turn-start.mjs (kept in step with it).
const DEFERRED_TURN_START_TOKEN = 'mock:deferred-turn-start';
/** The step bound of each wait in the cell; the run's own signals end every wait. */
const STEP_MS = 20_000;

/** OMP admits a steer into its running turn and acknowledges it there. The deferred-start token
 *  keeps the follow-up out of that turn, so OMP queues it as its next prompt, whose acknowledgement
 *  the control holds (scripts/mock-omp-rpc.mjs). */
const followUpText = (backend: string) => backend === 'omp' ? `${HELD_ACK} ${DEFERRED_TURN_START_TOKEN}` : HELD_ACK;

type Fixture = { store: RunStore; manager: RunManager; runId: string };
type Cell = { semaphore: WorkspaceSemaphore; clock: () => ReturnType<typeof observationClock>; state: () => activeRuns.ActiveRun };

const continued = (events: readonly { type: string; message?: unknown }[]) =>
  events.filter(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));

/** Where the held turn starts: its first event, and the idle timers armed before it. */
type Start = { seq: number; armed: number };

/** Open the held turn (fresh, or on a Continue after a parked first run), send the follow-up whose
 *  acknowledgement the mock withholds, and release the turn. */
async function sendHeldFollowUp(backend: string, continuation: boolean, releaseFile: string, { store, manager, runId }: Fixture, cell: Cell): Promise<Start> {
  if (continuation) {
    await waitFor(() => store.getRun(runId)?.status === 'waiting', STEP_MS);
    manager.finish(runId);
    await waitFor(() => !manager.isActive(runId), STEP_MS);
    store.updateRun(runId, { autonomous: true });
  }
  // The first run's park armed its own idle timer; the Continue's turn starts after it.
  const start = { seq: store.readEvents(runId).length, armed: cell.clock().captured };
  if (continuation) expect(manager.continueRun(runId, { text: promptFor(backend, 'hold-gated') }).ok).toBe(true);
  await waitFor(() => store.readEvents(runId).slice(start.seq).some(e => e.type === 'turn.started'), STEP_MS);
  expect(manager.sendMessage(runId, [{ type: 'text', text: followUpText(backend) }])).toBe(true);
  writeFileSync(releaseFile, '');
  return start;
}

/** The live row: the nudge is refused, the run keeps its slot until the real idle expiry closes
 *  the session, and it settles `waiting` with its step `waiting` once the process has exited. */
async function assertRefusedUntilIdle(backend: string, { store, manager, runId }: Fixture, start: Start, cell: Cell): Promise<void> {
  // The refusal arms the idle bound; nothing else arms it while an autonomous run runs.
  await waitFor(() => cell.clock().captured > start.armed && cell.clock().pending > 0, STEP_MS);
  const state = cell.state();
  const session = state.liveSession.session!;
  expect(state.boundary.nudge).toEqual({ session, cause: 'autonomous', state: 'refused' });
  expect(store.getRun(runId)?.status).toBe('running');
  expect(manager.isActive(runId)).toBe(true);
  expect(cell.semaphore.busy()).toBe(1);
  expect(continued(store.readEvents(runId).slice(start.seq))).toEqual([]);
  const sent = vi.spyOn(session, 'sendAgentMessage');
  await cell.clock().advance(IDLE_TIMEOUT_MS);
  expect(store.readEvents(runId).some(e => e.type === 'lifecycle' && String(e.message).includes('of inactivity'))).toBe(true);
  await waitFor(() => !manager.isActive(runId), STEP_MS);
  expect(cell.semaphore.busy()).toBe(0);
  expect(store.getRun(runId)?.status).toBe('waiting');
  expect(store.getRun(runId)?.steps.at(-1)?.status).toBe(STEP_STATUS.waiting);
  expect(sent).not.toHaveBeenCalled();
  sent.mockRestore();
  // The idle close left the run resumable.
  expect(manager.continueRun(runId, { text: promptFor(backend, 'cezar-done') }).ok).toBe(true);
  await waitFor(() => store.getRun(runId)?.status === 'done', STEP_MS);
}

/** The inverted row: the wire admits the nudge at that turn end, so no idle bound is armed and
 *  the run continues to its done. */
async function assertNudgeAdmitted({ store, runId }: Fixture, start: Start, cell: Cell): Promise<void> {
  await waitFor(() => store.getRun(runId)?.status === 'done', STEP_MS);
  expect(continued(store.readEvents(runId).slice(start.seq)).length).toBeGreaterThanOrEqual(1);
  expect(cell.clock().captured).toBe(start.armed);
}

/** Drive A13 (fresh) or A14 (`continuation`) on `backend`. `refuses` is false on an exempt wire.
 *  `heldAck` is false on a wire whose held acknowledgement cannot leave a turn end behind it:
 *  Claude's stdin write is the acknowledgement, so holding it holds the turn itself. */
export async function refusedNudgeIdleClose(backend: string, continuation: boolean, { refuses, heldAck }: { refuses: boolean; heldAck: boolean }): Promise<void> {
  const semaphore = new WorkspaceSemaphore({ home: testHome() });
  const releaseFile = join(tmpdir(), `cez-a13-release-${randomUUID()}`);
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
  const drive = (releaseAck: () => void) => driveRun(backend, continuation ? 'autonomous' : 'hold-gated', () => finished, 60_000, undefined, {
    semaphore, autonomous: !continuation, env: { CEZ_MOCK_RELEASE_FILE: releaseFile },
    // Only the product's idle clock is frozen; native processes keep real time.
    beforeStart: () => { clock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? '')); },
    beforeCleanup: () => { clock?.restore(); releaseAck(); },
    during: async fixture => {
      const start = await sendHeldFollowUp(backend, continuation, releaseFile, fixture, cell);
      if (refuses) await assertRefusedUntilIdle(backend, fixture, start, cell);
      else await assertNudgeAdmitted(fixture, start, cell);
      finished = true;
    },
  });
  try {
    if (heldAck) await withHeldAck(backend, async release => { await drive(release); }, HELD_ACK);
    else await drive(() => {});
  } finally {
    created.mockRestore();
    rmSync(releaseFile, { force: true });
  }
}
