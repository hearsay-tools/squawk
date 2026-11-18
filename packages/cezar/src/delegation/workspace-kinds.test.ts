import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

const calls: string[] = [];
const workspace: WorkerWorkspace = {
  ownerRunId: '11111111-1111-4111-8111-111111111111', resourceId: '22222222-2222-4222-8222-222222222222', kind: 'owned-isolated',
  path: '/repo/.ai/squawk/worktrees/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40),
};
const context = { inputs: [] };
const run = { id: workspace.ownerRunId, delegation: { role: 'worker', permissions: [], parentRunId: 'parent', workspace, context } } as unknown as RunRecord;
const request = { repoRoot: '/repo', dataDir: '/repo/.ai/squawk', run, parentCwd: '/parent' };

vi.mock('./workspace.ts', () => ({
  planOwnedWorkspace: vi.fn(async (...args: unknown[]) => { calls.push(`plan ${JSON.stringify(args)}`); return workspace; }),
  ensureOwnedWorkspace: vi.fn(async (repoRoot: string, record: RunRecord) => { calls.push(`ensure ${repoRoot} ${record.id}`); return workspace; }),
  verifyOwnedWorkspace: vi.fn(async (repoRoot: string, record: RunRecord) => { calls.push(`verify ${repoRoot} ${record.id}`); return workspace; }),
  readOwnedDiff: vi.fn(async (repoRoot: string, record: RunRecord) => { calls.push(`diff ${repoRoot} ${record.id}`); return { workerId: record.id, baselineSha: workspace.baselineSha, diff: 'patch', truncated: false }; }),
}));
vi.mock('./context.ts', () => ({
  prepareWorkerContext: vi.fn(async (options: { parentId: string }) => { calls.push(`prepare ${options.parentId}`); return { recipe: context, discard: async () => {} }; }),
  verifyWorkerContext: vi.fn(async (options: unknown) => { calls.push(`verify-context ${JSON.stringify(options)}`); }),
  placeWorkerAttachments: vi.fn(async (options: unknown) => { calls.push(`place ${JSON.stringify(options)}`); }),
}));
vi.mock('./owned-workspace-release.ts', () => ({
  releaseThenRemoveOwnedWorkspace: vi.fn(async (...args: unknown[]) => { calls.push('remove'); return { workerId: workspace.ownerRunId, state: 'complete', remaining: [], args }; }),
}));
vi.mock('./worktree-teardown.ts', () => ({
  runWorktreeTeardown: vi.fn(async (...args: unknown[]) => { calls.push(`teardown ${JSON.stringify(args)}`); return 'teardown failed'; }),
}));
const runGit = vi.hoisted(() => vi.fn());
vi.mock('../git-command.ts', () => ({ runGit }));

const { DEFAULT_WORKSPACE_CHOICE, workerWorkspacePort, workspaceKind, workspaceKindOf, workspaceKinds } = await import('./workspace-kinds.ts');
const isolated = workspaceKinds['owned-isolated'];

beforeEach(() => { calls.length = 0; runGit.mockReset(); });

describe('the workspace kind table', () => {
  it('has one definition for each kind a workspace record can name', () => {
    expect(Object.keys(workspaceKinds)).toEqual(['owned-isolated', 'shared']);
    expect(DEFAULT_WORKSPACE_CHOICE).toBe('isolated');
  });

  it('returns the definition a workspace record or a worker run names', () => {
    expect(workspaceKind(workspace)).toBe(isolated);
    expect(workspaceKindOf(run)).toBe(isolated);
  });

  it('refuses a kind that has no definition, and a run that is no worker', () => {
    expect(() => workspaceKind({ kind: 'toString' as never })).toThrow('Unknown worker workspace kind: toString');
    expect(() => workspaceKindOf({ id: 'root', delegation: { role: 'root' } } as unknown as RunRecord)).toThrow('Missing worker ownership');
  });
});

describe('the isolated workspace kind', () => {
  it('states that a destroy removes the worktree and the branch', () => {
    expect(isolated.destroyResources).toEqual(['worktree', 'branch']);
  });

  it('plans, prepares context and reads the diff through the owned-workspace functions', async () => {
    expect(await isolated.plan({ repoRoot: '/repo', workerId: workspace.ownerRunId, baselineSha: workspace.baselineSha, hostRunId: 'parent', hostDirectory: '/parent' })).toBe(workspace);
    await isolated.prepareContext({ repoRoot: '/repo', dataDir: '/data', parentId: 'parent', workspace, parentCwd: '/parent', context: {}, containsSecret: () => false });
    expect(await isolated.readDiff('/repo', run)).toMatchObject({ diff: 'patch' });
    expect(calls).toEqual([`plan ${JSON.stringify(['/repo', workspace.ownerRunId, workspace.baselineSha])}`, 'prepare parent', `diff /repo ${run.id}`]);
  });

  it('has a diff of its own, so it reports no change of a shared directory and does nothing at settlement', async () => {
    expect(isolated.noDiff).toBeUndefined();
    expect(isolated.workerNotice).toBeUndefined();
    expect(await isolated.changeReport('/data', run)).toBeUndefined();
    await isolated.settle(request);
    expect(calls).toEqual([]);
  });

  it('opens a first launch: ensures the workspace, verifies the context, then places the attachments', async () => {
    expect(await isolated.openForLaunch({ ...request, firstLaunch: true })).toEqual({ path: workspace.path, branch: workspace.branch, baseBranch: workspace.baselineSha });
    expect(calls).toEqual([
      `ensure /repo ${run.id}`,
      `verify-context ${JSON.stringify({ dataDir: request.dataDir, parentId: 'parent', workspace, context, parentCwd: '/parent' })}`,
      `place ${JSON.stringify({ dataDir: request.dataDir, workspace, context })}`,
    ]);
  });

  it('places no attachment on a later launch', async () => {
    await isolated.openForLaunch({ ...request, firstLaunch: false });
    expect(calls.map(call => call.split(' ')[0])).toEqual(['ensure', 'verify-context']);
  });

  it('opens a Continue in the verified directory without ensuring or placing', async () => {
    expect(await isolated.openForContinue(request)).toBe(workspace.path);
    expect(calls.map(call => call.split(' ')[0])).toEqual(['verify', 'verify-context']);
  });

  it('reads the head of the verified workspace', async () => {
    runGit.mockResolvedValue({ stdout: `${'b'.repeat(40)}\n` });
    expect(await isolated.readHead('/repo', run)).toBe('b'.repeat(40));
    expect(calls).toEqual([`verify /repo ${run.id}`]);
    expect(runGit).toHaveBeenCalledWith(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: workspace.path, timeout: 30_000, maxBuffer: 1024 });
  });

  it('is resumable while the verified workspace still has its branch', async () => {
    runGit.mockResolvedValue({ stdout: '' });
    await isolated.assertResumable('/repo', run);
    expect(runGit).toHaveBeenCalledWith(['rev-parse', '--verify', '--quiet', 'refs/heads/cez/worker^{commit}'], { cwd: '/repo', timeout: 30_000 });
    runGit.mockRejectedValue(new Error('exit 1'));
    await expect(isolated.assertResumable('/repo', run)).rejects.toThrow('branch cez/worker is missing');
  });

  it('tears down and removes through the teardown and release helpers', async () => {
    expect(await isolated.teardown('/repo', ['stop'], workspace)).toBe('teardown failed');
    const previewHost = { release: async () => {} };
    const assertCurrent = () => {};
    const assertUnheld = () => {};
    const removed = await isolated.remove('/repo', workspace, { previewHost, assertCurrent, assertUnheld }) as unknown as { state: string; args: unknown[] };
    expect(removed.state).toBe('complete');
    expect(removed.args).toStrictEqual([{ previewHost }, '/repo', workspace, assertCurrent, assertUnheld, {}]);
    const waited = await isolated.remove('/repo', workspace, { waitMs: 250 }) as unknown as { args: unknown[] };
    expect(waited.args).toStrictEqual([{ previewHost: undefined }, '/repo', workspace, undefined, undefined, { waitMs: 250 }]);
    expect(calls).toEqual([`teardown ${JSON.stringify(['/repo', ['stop'], workspace])}`, 'remove', 'remove']);
  });
});

describe('the worker workspace port', () => {
  it('sends a launch and a Continue to the definition the run names', async () => {
    expect(await workerWorkspacePort.openForLaunch({ ...request, firstLaunch: false })).toMatchObject({ path: workspace.path });
    expect(await workerWorkspacePort.openForContinue(request)).toBe(workspace.path);
    expect(calls.map(call => call.split(' ')[0])).toEqual(['ensure', 'verify-context', 'verify', 'verify-context']);
  });

  it('sends a settlement to the definition the run names, and never throws', async () => {
    await expect(workerWorkspacePort.settle(request)).resolves.toBeUndefined();
    await expect(workerWorkspacePort.settle({ ...request, run: { id: 'root' } as RunRecord })).resolves.toBeUndefined();
  });

  it('rejects a run that is no worker', async () => {
    await expect(workerWorkspacePort.openForContinue({ ...request, run: { id: 'root' } as RunRecord })).rejects.toThrow('Missing worker ownership');
  });
});
