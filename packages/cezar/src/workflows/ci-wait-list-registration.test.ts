import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import { WAIT_LIMIT } from '@open-mercato/cezar-contract/wait-limits';
import { GENERATION, identityOf, waitRegistryFixture, type WaitRegistryFixture } from './ci-wait-registration.testkit.ts';
import { timed } from './waits.testkit.ts';

// The wait list's registration policy in `WaitRegistry`: identity, duplicate deadlines, concurrent
// lookups, cancellation, the automatic-wake refusals and the capacity. Delivery to the run is on the
// real engine in `ci-wait-list-registration-engine.test.ts`.
type Fixture = WaitRegistryFixture;
const settledById = (f: Fixture, waitId: string) => f.store.getRun(f.run.id)?.lastWaits?.find(entry => entry.id === waitId);
const inputsFor = (f: Fixture, waitId: string) => f.store.getRun(f.run.id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

describe('Wait list registration and resolution', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('identical CI registration returns the existing wait id; a different timeout is refused without changing it', async () => {
    const f = waitRegistryFixture();
    const wait = timed(await f.registerPr(12, 30));
    const again = await f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr: 'https://github.com/Acme/Repo/pull/12', timeout_seconds: 30 }, 'cezar_wait', GENERATION);
    expect(again).toMatchObject({ id: wait.id, deadline: wait.deadline, timeoutSeconds: 30, until: 'checks' as const, wakeOnConflict: true });
    await expect(f.registerPr(12, 600)).rejects.toMatchObject({ code: 'duplicate_deadline', retainedWait: { id: wait.id, deadline: wait.deadline } });
    const timer = await f.registerTimer(120, 'deploy');
    expect((await f.registerTimer(120, 'deploy')).id).toBe(timer.id);
    expect((await f.registerTimer(180, 'deploy')).id).not.toBe(timer.id);
    expect(f.store.getRun(f.run.id)?.waits).toHaveLength(3);
  });

  it('cancelWait on an open CI wait aborts its watch and no observation is ever enqueued, even when the watcher settles afterwards', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = waitRegistryFixture();
    const wait = await f.registerPr(12);
    const kept = await f.registerTimer(600);
    expect(f.registry.cancelWait(f.run.id, wait.id, GENERATION)).toEqual({ cancelled: true });
    expect(f.github.aborted(12)).toBe(true);
    expect(settledById(f, wait.id)?.phase).toBe('cancelled');
    f.github.settle(12);
    await flushMicrotasks();
    expect(inputsFor(f, wait.id)).toEqual([]);
    expect(f.registry.cancelWait(f.run.id, wait.id, GENERATION)).toEqual({ cancelled: false, code: 'not_found' });
    expect(f.waitById(kept.id)?.phase).toBe('open');
    // The tool answer lists what is still open.
    const answer = await f.tools().cancelWait({ wait_id: kept.id }, new AbortController().signal);
    expect(answer).toEqual({ cancelled: true, wait_id: kept.id, open_waits: [] });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(inputsFor(f, kept.id)).toEqual([]);
    expect(settledById(f, kept.id)?.phase).toBe('cancelled');
  });

  it('two concurrent cezar_wait ci calls for different PRs both register', async () => {
    const f = waitRegistryFixture();
    let release!: () => void;
    const lookupGate = new Promise<void>(resolve => { release = resolve; });
    f.github.supervisor.resolve.mockImplementation(async url => { await lookupGate; return identityOf(url); });
    const pending = Promise.all([f.registerPr(12), f.registerPr(13)]);
    expect(f.github.supervisor.resolve).toHaveBeenCalledTimes(2);
    release();
    const [first, second] = await pending;
    expect(first.id).not.toBe(second.id);
    expect(f.store.getRun(f.run.id)?.waits?.map(wait => wait.kind === 'pr' ? wait.prNumber : undefined)).toEqual([12, 13]);
  });

  it('timer refuses wake_budget_spent once the run spent its automatic wakes', async () => {
    const f = waitRegistryFixture();
    f.store.updateRun(f.run.id, { automaticWakes: 40 });
    await expect(f.registerTimer()).rejects.toMatchObject({ code: 'wake_budget_spent' });
    await expect(f.registerPr(12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
  });

  it('registration refuses capacity at 16 open waits', async () => {
    const f = waitRegistryFixture();
    const opened: Wait[] = [];
    for (let n = 0; n < WAIT_LIMIT; n++) opened.push(await f.registerTimer(60 + n));
    await expect(f.registerTimer(600)).rejects.toMatchObject({ code: 'capacity' });
    await expect(f.registerPr(12)).rejects.toMatchObject({ code: 'capacity' });
    const answer = await f.tools().registerWait({ kind: WAIT_KIND.timer, seconds: 600 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'capacity' });
    expect(answer.answer.open_waits).toHaveLength(WAIT_LIMIT);
    // Only open waits count, as the store counts them: a resolved one frees its place. The timer's
    // deadline settles it through the engine, as its fired timer does.
    f.engine.settleWait(f.run.id, opened[0]!.id);
    expect(f.waitById(opened[0]!.id)?.phase).not.toBe('open');
    await expect(f.registerPr(12)).resolves.toMatchObject({ kind: WAIT_KIND.pr });
  });
});
