import { sealTestRunners } from '../core/runner-registry.testkit.ts';
// Register the external CI mock before loading RunManager.
import { generationOf, prUrl, registerPr, registerTimer, waitById, settledById, inputsFor, fireTimer, timerFired, githubByPr, waitingParent, expectNoWaitHumanWait, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/wait-factories.testkit';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { controlledWire, manager, parent, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-claude.testkit.ts';

sealTestRunners();

// The wait list's delivery on the real engine: resolved waits wake the run, a timer fires on the
// run's clock, and the workspace semaphore's interval leaves an open timer alone. The registration
// policy is a module test in `ci-wait-list-registration.test.ts`.
describe('Wait list registration and resolution', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());

  it('two CI waits for different PRs and a timer are open at once and resolve independently', async () => {
    const external = githubByPr();
    const run = await waitingParent();
    const first = await registerPr(run.id, 12);
    const second = await registerPr(run.id, 13);
    const timer = await registerTimer(run.id, 60, 'check the deploy');
    expect(store.getRun(run.id)?.waits?.map(wait => [wait.id, wait.phase])).toEqual([[first.id, 'open'], [second.id, 'open'], [timer.id, 'open']]);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(13);
    await until(() => settledById(run.id, second.id)?.phase === 'delivered');
    expect(inputsFor(run.id, second.id).map(input => input.text)).toEqual([expect.stringContaining(prUrl(13))]);
    expect([waitById(run.id, first.id)?.phase, waitById(run.id, timer.id)?.phase]).toEqual(['open', 'open']);
    fireTimer(timer.id);
    await until(() => settledById(run.id, timer.id)?.phase === 'delivered');
    expect(inputsFor(run.id, timer.id).map(input => input.text)).toEqual([timerFired(timer.id, 'check the deploy')]);
    expect(waitById(run.id, first.id)?.phase).toBe('open');
    external.settle(12);
    await until(() => settledById(run.id, first.id)?.phase === 'delivered');
    await expectNoWaitHumanWait(run.id);
    for (const wait of [first, second, timer]) expect(inputsFor(run.id, wait.id)).toHaveLength(1);
  });

  it('a timer registered with seconds=120 resolves at +120s with its note and enqueues one lifecycle input with the wait id', async () => {
    const run = await waitingParent();
    const charged = store.getRun(run.id)?.automaticWakes ?? 0;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const wait = await registerTimer(run.id, 120, 'check the deploy');
      expect(Date.parse(wait.deadline!) - Date.parse(wait.registeredAt)).toBe(120_000);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(waitById(run.id, wait.id)?.phase).toBe('open');
      expect(inputsFor(run.id, wait.id)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inputsFor(run.id, wait.id)).toMatchObject([{ source: 'lifecycle', text: timerFired(wait.id, 'check the deploy') }]);
      await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      // A timer expiry is a self-generated wake: its admitted turn counts against the session's budget.
      expect(store.eventLog.readEvents(run.id).filter(event => event.type === 'note' && event.message === `automatic timer wake-up (${charged + 1}/40)`)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('cancelWait on a resolved, undelivered wait answers already_resolved and the result is still delivered', async () => {
    const external = githubByPr();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const wait = await registerPr(run.id, 12);
    external.settle(12);
    await until(() => waitById(run.id, wait.id)?.phase === 'resolved');
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: false, code: 'already_resolved' });
    expect(waitById(run.id, wait.id)?.phase).toBe('resolved');
    writeFileSync(gate, 'end');
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toMatchObject([{ deliveredAt: expect.any(String) }]);
  });

  it('timer refuses timers_disabled when the interval is null; an open timer keeps its deadline when the interval changes', async () => {
    githubByPr();
    const run = await waitingParent();
    const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    await expect(registerTimer(run.id)).rejects.toMatchObject({ code: 'timers_disabled' });
    const answer = await manager.squawkToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'timers_disabled', open_waits: [] });
    // A refused registration registers nothing, so Squawk's own wait stays.
    expect(store.getRun(run.id)?.waits?.map(wait => wait.via)).toEqual(['no-wait']);
    // CI is an external event: Park until resumed does not refuse it.
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
    interval.mockReturnValue(5);
    const wait = await registerTimer(run.id, 600);
    interval.mockReturnValue(1);
    await semaphore.release();
    expect(waitById(run.id, wait.id)?.deadline).toBe(wait.deadline);
    interval.mockReturnValue(null);
    await semaphore.release();
    expect(waitById(run.id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open, deadline: wait.deadline });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(waitById(run.id, wait.id)?.phase).toBe('open');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
    vi.useRealTimers();
  });
});
