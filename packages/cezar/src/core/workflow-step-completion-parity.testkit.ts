import { workflowStepCompletionParity } from './workflow-step-completion-rows.testkit.ts';
import { autoEndObservationClock, observationClock } from './observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { IDLE_TIMEOUT_MS, NO_WAIT_NOTE, NO_WAIT_NUDGE_NOTE } from '../workflows/run.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE, STEP_NUDGE_SUFFIX } from '../workflows/turn-end.ts';
import { workflowDefSchema } from '../workflows/types.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { execFileSync } from 'node:child_process';
// Its stores reach worker executions: the shipped ones (hearsay-tools/squawk#4039).
import '../delegation/worker-executions.testkit.ts';

export const describeWorkflowStepCompletionParity = workflowStepCompletionParity((backend, row) => async () => {
  const workflowDef = workflowDefSchema.parse({ name: 'completion-chain', source: 'file', steps: [
    { id: 'implement', prompt: '{{task}}' },
    { id: 'review', prompt: promptFor(backend, 'cezar-done') },
    { id: 'verify', command: 'test -f a.txt' },
  ] });
  const parked = (run: RunRecord | undefined) => run?.status === 'waiting' &&
    (run.waits ?? []).some(wait => wait.kind === 'human' && wait.source === 'cezar');
  const finished = (run: RunRecord | undefined) => ['done', 'review', 'failed'].includes(run?.status ?? '');
  // The text Squawk submits to the session: an earlier step's nudge names the step.
  const submitted: string[] = [];
  let repoRoot = '';
  let idleClock: ReturnType<typeof observationClock>;
  let closeClock: ReturnType<typeof autoEndObservationClock>;
  const observe = ({ manager, repoRoot: root }: { manager: RunManager; repoRoot: string }) => {
    repoRoot = root;
    idleClock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
    closeClock = autoEndObservationClock();
    const work = fixtureWork(manager);
    const trackSession = work.trackSession.bind(work);
    vi.spyOn(work, 'trackSession').mockImplementation((session, closed) => {
      const submit = session.sendAgentMessage.bind(session);
      vi.spyOn(session, 'sendAgentMessage').mockImplementation((content, ids) => {
        for (const block of content) if (block.type === 'text') submitted.push(block.text);
        return submit(content, ids);
      });
      return trackSession(session, closed);
    });
  };
  const nudged = (nudge: string) => {
    expect(submitted.length).toBeGreaterThan(0);
    return submitted.some(text => text.startsWith(nudge) && text.includes(STEP_NUDGE_SUFFIX));
  };
  await driveRun(backend, row.scenario, run => parked(run) || finished(run), 20_000, async (fixture) => {
    let { manager, store } = fixture;
    const { runId } = fixture;
    const run = () => store.getRun(runId)!;
    // The workflow's own steps; a Continue adds a synthetic step beside them.
    const statuses = () => run().steps.filter(step => workflowDef.steps.some(def => def.id === step.id)).map(step => [step.id, step.status]);
    const notes = (message: string) => store.readEvents(runId).filter(event => event.type === 'note' && String(event.message).startsWith(message));
    const complete = async () => {
      await waitFor(() => finished(run()) && !manager.isActive(runId), 15_000);
      expect(run().status).toBe('done');
      expect(statuses()).toEqual([['implement', 'done'], ['review', 'done'], ['verify', 'done']]);
      expect(store.readEvents(runId).filter(event => event.type === 'check-output')).toMatchObject([{ stepId: 'verify', exitCode: 0 }]);
    };
    // The session closed without done: the step stays resumable and the tail never starts.
    const incomplete = async () => {
      await waitFor(() => !manager.isActive(runId));
      expect(run().status).toBe('waiting');
      expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
    };
    if (row.id === 'C6') {
      await complete();
      expect(nudged(AUTONOMOUS_NUDGE)).toBe(true);
      return;
    }
    // A quiet earlier turn end takes the final step's path: one nudge, then Squawk's human wait.
    expect(parked(run())).toBe(true);
    expect(notes(NO_WAIT_NUDGE_NOTE)).toHaveLength(1);
    expect(notes(NO_WAIT_NOTE)).toHaveLength(1);
    expect(nudged(NO_WAIT_NUDGE)).toBe(true);
    expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
    const session = [...fixtureWork(manager).liveSessions][0]!;
    // The session stays open for the user past the runners' one-shot-close window.
    await closeClock.advance(AUTO_END_DELAY_MS + 100);
    expect(session.open).toBe(true);
    if (row.id === 'C1') {
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'Carry on. mock:cezar-done' }])).toBe(true);
      await complete();
      return;
    }
    if (row.id === 'C3') {
      session.end();
      await incomplete();
      expect(manager.continueRun(runId, { text: 'Carry on. mock:cezar-done' }).ok).toBe(true);
      await complete();
      return;
    }
    if (row.id === 'C4') {
      await idleClock.advance(IDLE_TIMEOUT_MS);
      await incomplete();
      // A Continue whose turn signals nothing parks on the same step; only done advances it.
      expect(manager.continueRun(runId, { text: 'Carry on.' }).ok).toBe(true);
      await waitFor(() => manager.isActive(runId) && parked(run()), 15_000);
      expect(run().steps.find(step => step.id === 'review')?.status).toBe('pending');
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'Carry on. mock:cezar-done' }])).toBe(true);
      await complete();
      return;
    }
    const restart = async () => {
      store.flush();
      const dataDir = join(repoRoot, '.ai/cezar');
      const checkpoint = readPersistedRuns(dataDir);
      await drainFixtureManagers(repoRoot);
      store.close();
      seedRuns(dataDir, checkpoint);
      store = RunStore.open(dataDir, { keepLive: true });
      manager = createFixtureManager(store, repoRoot);
      await manager.recover();
    };
    if (row.id === 'C7') {
      session.end();
      await incomplete();
      // The agent left its task branch: the next execution's worktree check refuses the path.
      const { worktreePath, branch } = run();
      const git = (...args: string[]) => execFileSync('git', ['-C', worktreePath!, ...args]);
      git('checkout', '-q', '-b', 'elsewhere');
      expect(manager.continueRun(runId, { text: 'Carry on. mock:cezar-done' }).ok).toBe(true);
      await waitFor(() => run().status === 'failed' && !manager.isActive(runId), 15_000);
      expect(run().error).toContain('managed worktree path is registered to refs/heads/elsewhere');
      expect(statuses()).toEqual([['implement', 'done'], ['review', 'pending'], ['verify', 'pending']]);
      // No live session after a restart: the position is read from the saved row.
      await restart();
      expect(run().status).toBe('failed');
      expect(manager.isActive(runId)).toBe(false);
      // The repair, then a Continue whose done runs the tail; the completed step never replays.
      git('checkout', '-q', branch!);
      expect(manager.continueRun(runId, { text: 'Branch restored. mock:cezar-done' }).ok).toBe(true);
      await complete();
      const started = store.readEvents(runId).filter(event => event.type === 'step-start').map(event => event.stepId);
      expect(started.filter(id => workflowDef.steps.some(def => def.id === id))).toEqual(['implement', 'review', 'verify']);
      return;
    }
    // C5: a restart keeps the parked earlier step, and a Continue with done runs the tail.
    await restart();
    expect(run().status).toBe('waiting');
    expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
    expect(manager.isActive(runId)).toBe(false);
    expect(manager.continueRun(runId, { text: 'Carry on. mock:cezar-done' }).ok).toBe(true);
    await complete();
  }, { workflowDef, autonomous: row.id === 'C6', worktree: row.id === 'C7', beforeStart: observe, beforeCleanup: () => { idleClock?.restore(); closeClock?.restore(); vi.restoreAllMocks(); } });
});
