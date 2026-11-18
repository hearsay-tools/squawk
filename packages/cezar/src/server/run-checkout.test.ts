import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RUN_IN_USE_ELSEWHERE, type RunRecord } from '../runs/store.ts';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import { fallbackProjectWriteError } from '../project-paths.ts';
import { rematerializeReclaimedWorktree } from '../runs/retention.ts';
import { getStatus } from './git.ts';
import { preparePublishCheckout, reclaimCheckoutError, runCheckout, type RunCheckoutHost } from './run-checkout.ts';

vi.mock('../runs/retention.ts', () => ({ rematerializeReclaimedWorktree: vi.fn() }));
vi.mock('./git.ts', () => ({ getStatus: vi.fn() }));
vi.mock('../autosave-cleanup.ts', () => ({ autosaveCleanupBlocker: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), 'cez-run-checkout-'));
const live = join(root, 'live');
const gone = join(root, 'gone');
mkdirSync(live);
const fallback = join(root, '.ai', 'squawk', 'worktrees', 'fallback');
mkdirSync(join(root, '.ai/cezar'), { recursive: true }); // Exercise fallback admission in both states.
mkdirSync(fallback, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseRun: RunRecord = makeRunRecord({ id: '43d2b279-0dd9-49b5-aecb-1060c3020b9b' });
const notFound = { status: 404, body: { error: 'not found' } };
const noWorktree = { status: 409, body: { error: 'no worktree — this task ran directly in the repo working tree' } };
const fallbackError = { status: 409, body: { error: fallbackProjectWriteError(fallback)! } };
const fallbackGone = join(root, '.ai', 'squawk', 'worktrees', 'gone');
const stillWorking = { status: 409, body: { error: 'the agent is still working in this worktree' } };
const autosave = { status: 409, body: { error: 'autosave cleanup pending' } };

// One row per distinct read or mutate policy. HTTP tests guard each route.
const policies = [
  { intent: 'read', directory: 'existing-worktree', column: 'diff' },
  { intent: 'read', directory: 'working-directory', column: 'working' },
  { intent: 'read', directory: 'recorded-path-or-root', column: 'fileLink' },
  { intent: 'mutate', column: 'mutate' },
] as const;
type Expected = string | null | typeof notFound;
interface State {
  name: string;
  run: RunRecord | undefined;
  blocked: boolean;
  claimHeld?: boolean;
  foreignOwner?: boolean;
  diff: Expected;
  working: Expected;
  fileLink: Expected;
  mutate: Expected;
}
const states: State[] = [
  { name: 'unknown', run: undefined, blocked: false, mutate: notFound, diff: notFound, working: notFound, fileLink: notFound },
  { name: 'live', run: { ...baseRun, worktreePath: live }, blocked: false, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'worktree off', run: { ...baseRun, worktree: false }, blocked: false, mutate: noWorktree, diff: null, working: root, fileLink: root },
  { name: 'worktree off with recorded path', run: { ...baseRun, worktree: false, worktreePath: live }, blocked: false, mutate: live, diff: live, working: root, fileLink: live },
  { name: 'empty recorded path', run: { ...baseRun, worktreePath: '' }, blocked: false, mutate: noWorktree, diff: null, working: noWorktree, fileLink: '' },
  { name: 'no path', run: baseRun, blocked: false, mutate: noWorktree, diff: null, working: noWorktree, fileLink: root },
  { name: 'removed', run: { ...baseRun, worktreePath: gone }, blocked: false, mutate: noWorktree, diff: null, working: noWorktree, fileLink: gone },
  { name: 'reclaimed', run: { ...baseRun, worktreeReclaimedAt: '2026-11-10T01:00:00Z' }, blocked: false, mutate: noWorktree, diff: null, working: noWorktree, fileLink: root },
  { name: 'fallback', run: { ...baseRun, worktreePath: fallback }, blocked: false, mutate: fallbackError, diff: fallback, working: fallback, fileLink: fallback },
  { name: 'fallback with autosave', run: { ...baseRun, worktreePath: fallback }, blocked: true, mutate: fallbackError, diff: fallback, working: fallback, fileLink: fallback },
  { name: 'fallback removed', run: { ...baseRun, worktreePath: fallbackGone }, blocked: false, mutate: { status: 409, body: { error: fallbackProjectWriteError(fallbackGone)! } }, diff: null, working: noWorktree, fileLink: fallbackGone },
  { name: 'worker', run: { ...baseRun, worktreePath: live, delegation: {
    role: 'worker', parentRunId: '0869dc16-0d6e-48a1-a693-e32cafc02c3f', permissions: [],
    workspace: { ownerRunId: baseRun.id, resourceId: baseRun.id, kind: 'owned-isolated', path: live, branch: 'worker', baselineSha: 'a'.repeat(40) },
  } }, blocked: false, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'claim held elsewhere', run: { ...baseRun, worktreePath: live }, blocked: false, claimHeld: true, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'foreign owner', run: { ...baseRun, worktreePath: live }, blocked: false, foreignOwner: true, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'running', run: { ...baseRun, status: RUN_STATUS.running, worktreePath: live }, blocked: false, mutate: stillWorking, diff: live, working: live, fileLink: live },
  { name: 'usage hold', run: { ...baseRun, status: RUN_STATUS.waiting, autoResumeAt: '2026-11-11T00:00:00Z', worktreePath: live }, blocked: false, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'autosave with live path', run: { ...baseRun, worktreePath: live }, blocked: true, mutate: live, diff: live, working: live, fileLink: live },
  { name: 'autosave with removed path', run: { ...baseRun, worktreePath: gone }, blocked: true, mutate: noWorktree, diff: null, working: noWorktree, fileLink: gone },
  { name: 'autosave with unknown id', run: undefined, blocked: true, mutate: notFound, diff: notFound, working: notFound, fileLink: notFound },
];

function fakeHost({ run, claimHeld, foreignOwner }: State): RunCheckoutHost {
  const forbidden = () => { throw new Error('read or mutate must not check ownership, claim or write'); };
  return {
    root,
    store: {
      getRun: vi.fn(() => run), sourceDataDir: vi.fn(() => join(root, 'source')),
      updateRun: forbidden, writeRefusal: vi.fn(() => foreignOwner ? RUN_IN_USE_ELSEWHERE : undefined),
      fallbackDeleteError: forbidden, canDeleteRun: forbidden, listWorkersOf: forbidden,
    },
    manager: { isActive: forbidden, claimForPublish: vi.fn(claimHeld ? () => null : forbidden), claimWorktreeReclaim: vi.fn(claimHeld ? () => null : forbidden) },
  };
}

describe.each(policies)('$intent $column policy', (route) => {
  it.each([...states, ...(['queued', 'waiting'] as const).map(status => ({
    ...states[1]!, name: status, run: { ...baseRun, status, worktreePath: live },
  })), { ...states[14]!, name: 'running with autosave', blocked: true }, {
    ...states[8]!, name: 'running fallback', run: { ...baseRun, status: RUN_STATUS.running, worktreePath: fallback },
  }, { ...states[5]!, name: 'running without directory', mutate: stillWorking, run: { ...baseRun, status: RUN_STATUS.running } }])('$name keeps admission order and directory policy', (state) => {
    const host = fakeHost(state);
    vi.mocked(autosaveCleanupBlocker).mockReset().mockReturnValue(state.blocked ? autosave.body.error : undefined);
    const result = route.intent === 'mutate'
      ? runCheckout(host, baseRun.id, 'mutate')
      : runCheckout(host, baseRun.id, 'read', route);
    const checksMutationAutosave = Boolean(state.run && route.intent === 'mutate' && state.run.status !== 'running' && !(state.run.worktreePath && fallbackProjectWriteError(state.run.worktreePath)));
    const expected = checksMutationAutosave && state.blocked ? autosave : state[route.column];
    expect(result).toEqual(typeof expected === 'object' && expected !== null
      ? expected
      : {
        run: state.run,
        directory: expected,
        ...(route.intent === 'read' ? { beforeLiveIndex: expect.any(Function) } : {}),
      });
    expect(host.store.writeRefusal).not.toHaveBeenCalled();
    expect(host.manager.claimForPublish).not.toHaveBeenCalled();
    expect(host.manager.claimWorktreeReclaim).not.toHaveBeenCalled();
    expect(host.store.getRun).toHaveBeenCalledExactlyOnceWith(baseRun.id);
    expect(autosaveCleanupBlocker).toHaveBeenCalledTimes(Number(checksMutationAutosave));
    expect(host.store.sourceDataDir).toHaveBeenCalledTimes(Number(checksMutationAutosave));
    if (checksMutationAutosave) {
      expect(autosaveCleanupBlocker).toHaveBeenCalledWith(join(root, 'source'), baseRun.id);
    }
  });
});

const cleanupPending = 'worktree cleanup pending — retry after cleanup is confirmed';
const publishPending = 'its worktree or branch is being cleaned up — retry in a moment';
const reclaimPending = "this worktree is in use or already reclaimed — only a finished task's worktree can be reclaimed";
const activeRemove = 'run is active — cancel it first';
const activePublish = 'run is still active — wait for the review gate';
const workerRemove = 'owned resources require verified worker cleanup';
const recordRemove = 'owned resources require verified worker cleanup and explicit child history deletion first';
const holdPublish = 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry Draft PR';
const holdRemove = 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry';
const fallbackRefusal = fallbackProjectWriteError(fallback)!;
const claimedRoutes = [
  { route: 'pr', intent: 'publish' },
  { route: 'remove-worktree', intent: 'remove', claim: 'publish', checksActive: true, deletion: 'worktree', nullClaimError: cleanupPending },
  { route: 'DELETE', intent: 'remove', claim: 'publish', checksActive: true, deletion: 'record', nullClaimError: cleanupPending },
  { route: 'reclaim', intent: 'remove', claim: 'reclaim', checksActive: false, deletion: 'inline', nullClaimError: reclaimPending },
] as const;
// Each tuple is pr / remove-worktree / DELETE / reclaim. null means admitted.
const claimedOutcomes: Record<string, readonly (string | null | 404)[]> = {
  unknown: [404, 404, 404, 404],
  live: [null, null, null, null],
  'worktree off': [null, null, null, null],
  'worktree off with recorded path': [null, null, null, null],
  'empty recorded path': [null, null, null, null],
  'no path': [null, null, null, null],
  removed: [null, null, null, null],
  reclaimed: [null, null, null, null],
  fallback: [fallbackRefusal, null, null, fallbackRefusal], // Removal middleware remains outside admission.
  'fallback with autosave': [fallbackRefusal, null, null, fallbackRefusal],
  'fallback removed': [fallbackProjectWriteError(fallbackGone)!, null, null, fallbackProjectWriteError(fallbackGone)!],
  worker: [null, workerRemove, recordRemove, null],
  'claim held elsewhere': [publishPending, cleanupPending, cleanupPending, reclaimPending],
  'foreign owner': [publishPending, cleanupPending, cleanupPending, RUN_IN_USE_ELSEWHERE],
  running: [activePublish, activeRemove, activeRemove, reclaimPending],
  'usage hold': [holdPublish, holdRemove, holdRemove, holdRemove],
  'autosave with live path': [null, null, null, null],
  'autosave with removed path': [null, null, null, null],
  'autosave with unknown id': [404, 404, 404, 404],
};

function claimedHost(state: State) {
  const calls: string[] = [];
  const release = vi.fn(() => { calls.push('release'); });
  const claim = (kind: string) => {
    calls.push(kind);
    return state.claimHeld || state.foreignOwner ? null : release;
  };
  const host: RunCheckoutHost = {
    root,
    store: {
      getRun: vi.fn(() => { calls.push('lookup'); return state.run; }),
      updateRun: vi.fn(), sourceDataDir: vi.fn(), listWorkersOf: vi.fn(() => []),
      canDeleteRun: vi.fn(() => { calls.push('can-delete'); return state.run?.delegation?.role !== 'worker'; }),
      fallbackDeleteError: vi.fn(() => { calls.push('fallback'); return state.run?.worktreePath ? fallbackProjectWriteError(state.run.worktreePath) : undefined; }),
      writeRefusal: vi.fn(() => { calls.push('owner'); return state.foreignOwner ? RUN_IN_USE_ELSEWHERE : undefined; }),
    },
    manager: {
      isActive: vi.fn(() => { calls.push('active'); return state.run?.status === RUN_STATUS.running; }),
      claimForPublish: vi.fn(() => claim('publish')),
      claimWorktreeReclaim: vi.fn(() => {
        if (state.run?.status === RUN_STATUS.running) { calls.push('reclaim'); return null; }
        return claim('reclaim');
      }),
    },
  };
  return { host, calls, release };
}

describe("a worker that runs in its parent's worktree (hearsay-tools/squawk#3819)", () => {
  const id = '5b0c8d3a-41c5-4b0e-9c57-3f0a1c2d4e5f';
  const shared = makeRunRecord({ id, status: RUN_STATUS.done, baseBranch: 'a'.repeat(40), delegation: { role: 'worker', permissions: [], parentRunId: baseRun.id,
    workspace: { ownerRunId: id, resourceId: '0d0e7a51-7a35-4c53-8a5c-0c7f5f9d2b11', kind: 'shared', path: live, hostRunId: baseRun.id, baselineSha: 'a'.repeat(40) } } });
  const refusal = (action: string) => ({ status: 409, body: { error: `this worker runs in its parent's worktree — ${action}` } });
  function sharedHost(run: RunRecord = shared, workers: RunRecord[] = []): RunCheckoutHost {
    return { root, store: { getRun: vi.fn(() => run), updateRun: vi.fn(), sourceDataDir: vi.fn(() => root), writeRefusal: vi.fn(() => undefined),
      fallbackDeleteError: vi.fn(() => undefined), canDeleteRun: vi.fn(() => true), listWorkersOf: vi.fn(() => workers) },
      manager: { isActive: vi.fn(() => false), claimForPublish: vi.fn(() => () => undefined), claimWorktreeReclaim: vi.fn(() => () => undefined) } };
  }

  it('refuses commit, push, the pull request, worktree removal and reclaim in one text family, and claims nothing', () => {
    const host = sharedHost();
    vi.mocked(autosaveCleanupBlocker).mockReset();
    expect(runCheckout(host, id, 'mutate')).toEqual(refusal('commit and push from the parent task'));
    expect(runCheckout(host, id, 'publish')).toEqual(refusal('open the pull request from the parent task'));
    expect(runCheckout(host, id, 'remove', { claim: 'publish', checksActive: true, deletion: 'worktree', nullClaimError: 'pending' }))
      .toEqual(refusal('it has no worktree or branch to remove'));
    expect(runCheckout(host, id, 'remove', { claim: 'reclaim', checksActive: false, deletion: 'inline', nullClaimError: 'in use' }))
      .toEqual(refusal('it has no worktree or branch to remove'));
    expect(host.manager.claimForPublish).not.toHaveBeenCalled();
    expect(host.manager.claimWorktreeReclaim).not.toHaveBeenCalled();
    expect(host.store.updateRun).not.toHaveBeenCalled();
  });

  it('still admits history deletion, and reads no worktree of its own', () => {
    const host = sharedHost();
    expect(runCheckout(host, id, 'remove', { claim: 'publish', checksActive: true, deletion: 'record', nullClaimError: 'pending' }))
      .toEqual({ run: shared, release: expect.any(Function) });
  });

  it('reads from the recorded host directory: changes, a transcript file link and open-in-cli', () => {
    const host = sharedHost();
    expect(shared.worktreePath).toBeUndefined();
    for (const directory of ['existing-worktree', 'working-directory', 'recorded-path-or-root'] as const) {
      expect(runCheckout(host, id, 'read', { directory }), directory).toMatchObject({ run: shared, directory: live });
    }
    const open = runCheckout(host, id, 'open');
    if ('status' in open) throw new Error('open refused');
    expect(open.directory()).toBe(live);
    expect(open.worktree).toBe(live);
    expect(open.defaultWorktree()).toBe(live);
  });

  it('falls back as a run without a worktree does once the host directory is gone', () => {
    const lost = { ...shared, delegation: { ...shared.delegation, workspace: { ...(shared.delegation as { workspace: object }).workspace, path: gone } } } as RunRecord;
    const host = sharedHost(lost);
    expect(runCheckout(host, id, 'read', { directory: 'existing-worktree' })).toMatchObject({ directory: null });
    expect(runCheckout(host, id, 'read', { directory: 'working-directory' })).toEqual(noWorktree);
    const open = runCheckout(host, id, 'open');
    expect('status' in open ? undefined : open.directory()).toBe(root);
  });

  it('refuses to remove or reclaim the worktree of a task while a live worker runs in it, and admits it once the worker ended', () => {
    const hostRun = makeRunRecord({ id: baseRun.id, status: RUN_STATUS.failed, worktreePath: live, delegation: { role: 'root', permissions: [], receipts: [] } });
    const running = { ...shared, status: RUN_STATUS.running } as RunRecord;
    const removal = { claim: 'publish', checksActive: true, deletion: 'worktree', nullClaimError: 'pending' } as const;
    const reclaim = { claim: 'reclaim', checksActive: false, deletion: 'inline', nullClaimError: 'in use' } as const;
    const busy = sharedHost(hostRun, [running]);
    const refused = { status: 409, body: { error: "a worker runs in this task's worktree — stop it or clean it up first" } };
    expect(runCheckout(busy, hostRun.id, 'remove', removal)).toEqual(refused);
    expect(runCheckout(busy, hostRun.id, 'remove', reclaim)).toEqual(refused);
    expect(busy.manager.claimForPublish).not.toHaveBeenCalled();
    expect(busy.manager.claimWorktreeReclaim).not.toHaveBeenCalled();
    expect(busy.store.listWorkersOf).toHaveBeenCalledWith(hostRun.id);
    const free = sharedHost(hostRun, [shared]);
    expect(runCheckout(free, hostRun.id, 'remove', removal)).toEqual({ run: hostRun, release: expect.any(Function) });
    expect(runCheckout(free, hostRun.id, 'remove', reclaim)).toEqual({ run: hostRun, release: expect.any(Function) });
  });
});

function admitClaimed(host: RunCheckoutHost, route: typeof claimedRoutes[number]) {
  return route.intent === 'publish'
    ? runCheckout(host, baseRun.id, 'publish')
    : runCheckout(host, baseRun.id, 'remove', route);
}

describe.each(claimedRoutes)('$intent $route', (route) => {
  it.each(states)('$name keeps synchronous admission and claim policy', (state) => {
    const { host, calls, release } = claimedHost(state);
    vi.mocked(autosaveCleanupBlocker).mockClear();
    const result = admitClaimed(host, route);
    const expected = claimedOutcomes[state.name]![claimedRoutes.indexOf(route)];
    expect(result).toEqual(expected === null ? { run: state.run, release }
      : { status: expected === 404 ? 404 : 409, body: { error: expected === 404 ? 'not found' : expected } });
    expect(calls[0]).toBe('lookup');
    expect(autosaveCleanupBlocker).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const claims = calls.filter(call => call === 'publish' || call === 'reclaim');
    expect(claims.length).toBe(Number(expected === null || [publishPending, cleanupPending, reclaimPending].includes(String(expected))));
    if (expected === null) expect(calls.at(-1)).toBe(route.route === 'reclaim' ? 'reclaim' : 'publish');
  });
});

describe('claim check order', () => {
  it.each(claimedRoutes)('$route keeps its full order before claiming', route => {
    const { host, calls } = claimedHost(states[1]!);
    admitClaimed(host, route);
    const orders = {
      pr: ['lookup', 'active', 'publish'],
      'remove-worktree': ['lookup', 'active', 'can-delete', 'publish'],
      DELETE: ['lookup', 'active', 'can-delete', 'publish'],
      reclaim: ['lookup', 'fallback', 'owner', 'reclaim'],
    };
    expect(calls).toEqual(orders[route.route]);
  });

  it('DELETE refuses an unknown id before checking activity', () => {
    const { host, calls } = claimedHost(states[0]!);
    vi.mocked(host.manager.isActive).mockImplementation(() => { calls.push('active'); return true; });
    expect(admitClaimed(host, claimedRoutes[2])).toEqual({ status: 404, body: { error: 'not found' } });
    expect(calls).toEqual(['lookup']);
  });

  it('reclaim fallback refusal wins over foreign ownership and claiming', () => {
    const { host, calls } = claimedHost({ ...states[8]!, foreignOwner: true });
    expect(admitClaimed(host, claimedRoutes[3])).toEqual({ status: 409, body: { error: fallbackRefusal } });
    expect(calls).toEqual(['lookup', 'fallback']);
  });
});

describe('publish preparation under the caller claim', () => {
  it.each([
    { name: 'missing record', run: undefined, status: 404 },
    { name: 'missing path', run: baseRun, status: 409 },
    { name: 'removed directory', run: { ...baseRun, worktreePath: gone, branch: 'task' }, status: 409 },
    { name: 'missing branch', run: { ...baseRun, worktreePath: live }, status: 409 },
    { name: 'restored checkout', run: { ...baseRun, worktreePath: live, branch: 'task' }, status: null },
  ])('$name reads the fresh record after rebuilding', async ({ run, status }) => {
    const { host, calls, release } = claimedHost(states[1]!);
    const checkout = runCheckout(host, baseRun.id, 'publish');
    expect(checkout).toHaveProperty('release', release);
    vi.mocked(rematerializeReclaimedWorktree).mockImplementationOnce(async () => {
      calls.push('rebuild');
      vi.mocked(host.store.getRun).mockImplementation(() => { calls.push('lookup'); return run; });
      return true;
    });
    const result = await preparePublishCheckout(host, baseRun.id);
    expect(calls).toEqual(['lookup', 'active', 'publish', 'rebuild', 'lookup']);
    expect(rematerializeReclaimedWorktree).toHaveBeenLastCalledWith(root, host.store, baseRun.id);
    expect(result).toEqual(status === null ? { run } : { status, body: { error: status === 404 ? 'not found' : 'no worktree/branch to publish — this task ran in the repo working tree' } });
    expect(release).not.toHaveBeenCalled();
    release();
  });

  it('propagates rebuild failure to the caller finally', async () => {
    const { host, release } = claimedHost(states[1]!);
    const checkout = runCheckout(host, baseRun.id, 'publish');
    if ('status' in checkout) throw new Error('expected admission');
    const failure = new Error('rebuild failed');
    vi.mocked(rematerializeReclaimedWorktree).mockRejectedValueOnce(failure);
    await expect((async () => {
      try { await preparePublishCheckout(host, baseRun.id); } finally { checkout.release(); }
    })()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('reclaim failure detail after release', () => {
  it.each([
    { count: 0, error: 'the worktree directory could not be removed' },
    { count: 1, error: 'the worktree has 1 uncommitted file that exist nowhere else — commit or discard them first' },
    { count: 2, error: 'the worktree has 2 uncommitted files that exist nowhere else — commit or discard them first' },
  ])('reports $count dirty files after the caller releases', async ({ count, error }) => {
    const { host, release } = claimedHost(states[1]!);
    const checkout = admitClaimed(host, claimedRoutes[3]);
    if ('status' in checkout) throw new Error('expected admission');
    vi.mocked(getStatus).mockImplementationOnce(async () => {
      expect(release).toHaveBeenCalledOnce();
      return Array.from({ length: count }, () => ({ path: 'file', status: '??' }));
    });
    await Promise.resolve(null).finally(checkout.release);
    expect(await reclaimCheckoutError(checkout.run)).toBe(error);
  });

  it.each([undefined, gone])('does not ask git for an absent directory (%s)', async worktreePath => {
    vi.mocked(getStatus).mockClear();
    expect(await reclaimCheckoutError({ ...baseRun, worktreePath })).toBe('the worktree directory could not be removed');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('keeps the removal message when git status fails', async () => {
    vi.mocked(getStatus).mockRejectedValueOnce(new Error('git failed'));
    expect(await reclaimCheckoutError({ ...baseRun, worktreePath: live })).toBe('the worktree directory could not be removed');
  });
});

describe('open checkout', () => {
  it.each([...states, ...(['queued', 'waiting'] as const).map((status) => ({
    ...states[1]!, name: status, run: { ...baseRun, status, worktreePath: live },
  }))])('$name keeps the current open policy without a claim', (state) => {
    const host = fakeHost(state);
    const result = runCheckout(host, baseRun.id, 'open');
    if (!state.run) {
      expect(result).toEqual(notFound);
      return;
    }
    if ('status' in result) throw new Error('expected an open handle');
    const worktree = state.diff === live || state.diff === fallback ? state.diff : null;
    expect(result.run).toBe(state.run);
    expect(result.directory()).toBe(worktree ?? root);
    expect(result.worktree).toBe(worktree);
    expect(result.defaultWorktree()).toEqual(state.run.worktree === false ? root : worktree ?? noWorktree);
    expect(result.resumeAllowed).toBe((state.name === 'usage hold' || !['running', 'queued', 'waiting'].includes(state.run.status)));
    expect(host.store.getRun).toHaveBeenCalledExactlyOnceWith(baseRun.id);
    expect(host.store.writeRefusal).not.toHaveBeenCalled();
    expect(host.store.sourceDataDir).not.toHaveBeenCalled();
    expect(host.manager.claimForPublish).not.toHaveBeenCalled();
    expect(host.manager.claimWorktreeReclaim).not.toHaveBeenCalled();
  });
});

it('resolves the open directory at call time after lookup', () => {
  const path = join(root, 'lazy');
  mkdirSync(path);
  const host = fakeHost({ ...states[1]!, run: { ...baseRun, worktreePath: path } });
  const result = runCheckout(host, baseRun.id, 'open');
  if ('status' in result) throw new Error('expected an open handle');
  rmSync(path, { recursive: true });
  expect(result.directory()).toBe(root);
  expect(result.worktree).toBeNull();
  mkdirSync(path);
  expect(result.directory()).toBe(path);
  expect(result.worktree).toBe(path);
});
