import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WAIT_KIND } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { createActiveRun } from './active-run.ts';
import { GENERATION, identityOf, waitRegistryFixture, type WaitRegistryFixture } from './ci-wait-registration.testkit.ts';

const pr = 'https://github.com/acme/repo/pull/12';
const identity = identityOf(pr);
type Fixture = WaitRegistryFixture;
const ciWaitOf = (f: Fixture) => f.store.getRun(f.run.id)?.waits?.find(entry => entry.kind === 'pr');
// hearsay-tools/cezarion#1233 dropped `human_ask_pending` and `human_ask_unanswered`: a wait now
// registers under a pending question, which outranks it in `waitingOn` (pinned below).
const codes = ['manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'worker_execution_stopped', 'root_finish_pending'] as const;
type GuardCode = typeof codes[number];

/** Overrides one run read with this patch; `undefined` reads the run as missing. */
function readRunAs(f: Fixture, patch: (run: NonNullable<ReturnType<Fixture['store']['getRun']>>) => ReturnType<Fixture['store']['getRun']>) {
  const readRun = f.store.getRun.bind(f.store);
  vi.spyOn(f.store, 'getRun').mockImplementation(id => id === f.run.id ? patch(readRun(id)!) : readRun(id));
}

/** Puts the run into the state each code names, before the call or while its lookup is in flight. */
const trigger: Record<GuardCode, (f: Fixture, capability: AbortController, duringLookup: boolean) => void> = {
  manager_disposed: f => f.dispose(),
  capability_revoked: (_f, capability) => capability.abort(),
  run_missing: f => readRunAs(f, () => undefined),
  run_not_running: f => readRunAs(f, run => ({ ...run, status: RUN_STATUS.review })),
  run_stopping: f => readRunAs(f, run => ({ ...run, stopping: true })),
  // Before the call no active run is left; during the lookup a new one replaces it.
  session_replaced: (f, _capability, duringLookup) => {
    if (duringLookup) f.active.set(f.run.id, createActiveRun({ cwd: f.root, pendingHumanAsk: false, autonomous: false }));
    else f.active.delete(f.run.id);
  },
  session_closed: f => { f.session.open = false; },
  run_cancelled: f => f.state.liveSession.cancel(),
  finish_requested: f => f.state.liveSession.requestFinish(),
  // Before the call the tool presents another generation; during the lookup the session's one rotates.
  generation_mismatch: (f, _capability, duringLookup) => { if (duringLookup) f.state.liveSession.beginCiGeneration('replaced'); },
  worker_execution_stopped: f => {
    const delegation = f.store.getRun(f.run.id)!.delegation!;
    if (delegation.role !== 'root') throw new Error('expected root');
    f.store.commitDelegation([{ id: f.run.id, delegation: { ...delegation, historyDeletion: 'pending' } }]);
  },
  root_finish_pending: f => {
    setRunStatus(f.store, f.run.id, RUN_STATUS.waiting);
    f.store.commitRootFinishIntent(f.run.id);
  },
};

describe('CI registration guards before and after metadata lookup', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(codes.flatMap(code => [false, true].map(duringLookup => ({ code, duringLookup }))))
  ('$code duringLookup=$duringLookup returns its blocking state without persisting a wait', async ({ code, duringLookup }) => {
    const f = waitRegistryFixture();
    const capability = new AbortController();
    let finish!: () => void;
    f.github.supervisor.resolve.mockImplementation(async () => {
      if (duringLookup) await new Promise<void>(done => { finish = done; });
      return identity;
    });
    const generation = code === 'generation_mismatch' && !duringLookup ? 'different' : GENERATION;
    const call = () => f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', generation, capability.signal);
    const pending = duringLookup ? call() : undefined;
    const assertion = pending ? expect(pending).rejects.toMatchObject({ code }) : undefined;
    // The lookup starts synchronously inside the call.
    if (duringLookup) expect(finish).toBeDefined();
    trigger[code](f, capability, duringLookup);
    if (pending) { finish(); await assertion; }
    else await expect(call()).rejects.toMatchObject({ code });
    if (!duringLookup) expect(f.github.supervisor.resolve).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(ciWaitOf(f)).toBeUndefined();
  });

  it('registers CI and a timer with an unanswered human question in the record', async () => {
    const f = waitRegistryFixture();
    f.store.eventLog.appendEvent(f.run.id, { type: 'ask.requested', requestId: 'unanswered-question', questions: [{ header: 'Review', question: 'Approve?' }] });
    const ci = await f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', GENERATION);
    const timer = await f.registry.registerWait(f.run.id, { kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', GENERATION);
    expect(f.store.getRun(f.run.id)?.waits?.map(wait => wait.id)).toEqual([ci.id, timer.id]);
  });
});

// hearsay-tools/cezarion#1425: a checks wait never stands in for a merge wait on the same PR.
describe('PR wait targets', () => {
  it('opens a checks wait and a merge wait on one PR as two waits, and shares one lookup for a repeat', async () => {
    const f = waitRegistryFixture();
    let lookups = 0;
    let release!: () => void;
    f.github.supervisor.resolve.mockImplementation(async () => { lookups++; await new Promise<void>(done => { release = done; }); return identity; });
    const watched: unknown[] = [];
    f.github.supervisor.watch.mockImplementation(wait => { watched.push(wait); return new Promise(() => {}); });
    const checks = f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr }, 'cezar_wait', GENERATION);
    expect(lookups).toBe(1); release();
    const first = await checks;
    const merges = [0, 1].map(() => f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr, until: 'merge', wake_on_conflict: false }, 'cezar_wait', GENERATION));
    expect(lookups).toBe(2); release();
    const [merge, repeat] = await Promise.all(merges);
    expect(lookups).toBe(2);
    expect(repeat!.id).toBe(merge!.id);
    expect(merge!.id).not.toBe(first.id);
    expect(f.store.getRun(f.run.id)?.waits).toEqual([
      expect.objectContaining({ id: first.id, kind: WAIT_KIND.pr, until: 'checks', wakeOnConflict: true }),
      expect.objectContaining({ id: merge!.id, kind: WAIT_KIND.pr, until: 'merge', wakeOnConflict: false }),
    ]);
    expect(watched).toEqual([expect.objectContaining({ until: 'checks', wakeOnConflict: true }), expect.objectContaining({ until: 'merge', wakeOnConflict: false })]);
  });
});

describe('CI metadata lookup interruption', () => {
  it.each(['registration_aborted', 'turn_changed', 'capability_revoked'] as const)
  ('reports %s even if the interrupted lookup rejects', async code => {
    const f = waitRegistryFixture();
    const capability = new AbortController();
    let fail!: (reason: Error) => void;
    f.github.supervisor.resolve.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = f.registry.registerWait(f.run.id, { kind: WAIT_KIND.pr, pr }, 'cezar_wait', GENERATION, capability.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code });
    if (code === 'registration_aborted') f.registry.abortRegistrations(f.run.id);
    else if (code === 'turn_changed') f.state.waitIdentity.rotateCiTurn('next-turn');
    else capability.abort();
    fail(new Error('lookup aborted'));
    await assertion;
    expect(ciWaitOf(f)).toBeUndefined();
  });
});
