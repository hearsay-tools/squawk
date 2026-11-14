import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { fixture, git, receiptPath, recordingReport, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

const hook = vi.hoisted(() => ({
  beforeContains: undefined as ((sha: string) => void) | undefined,
  after: undefined as ((args: readonly string[], ok: boolean) => void) | undefined,
  afterHead: undefined as ((refusal: string | undefined) => void) | undefined,
}));
afterEach(() => { hook.beforeContains = undefined; hook.after = undefined; hook.afterHead = undefined; });

// The HEAD read seam: an outside change can land right after destroy reads the worktree HEAD.
vi.mock('../task-branch-head.ts', async (original) => {
  const real = await original<typeof import('../task-branch-head.ts')>();
  return {
    ...real,
    headLeftTaskBranch: async (worktree: string, branch: string) => {
      const refusal = await real.headLeftTaskBranch(worktree, branch);
      hook.afterHead?.(refusal);
      return refusal;
    },
  };
});

// The lock seam: a ref that keeps the worker's commits can move between two reads of it, as an
// outside process (a shell, an IDE) that does not follow Squawk's lock can move it.
vi.mock('../git-worktree-lock.ts', async (original) => {
  const real = await original<typeof import('../git-worktree-lock.ts')>();
  return {
    ...real,
    withWorktreeMutation: <T>(root: string, operation: Parameters<typeof real.withWorktreeMutation<T>>[1], options?: { waitMs?: number }) =>
      real.withWorktreeMutation(root, (lockedGit) => operation(async (cwd, args, timeout, input) => {
        if (args[0] === 'for-each-ref' && args[1] === '--contains' && args[2]) hook.beforeContains?.(args[2]);
        const result = await lockedGit(cwd, args, timeout, input);
        hook.after?.(args, result.ok);
        return result;
      }), options),
  };
});

const { removeOwnedWorkspace } = await import('./workspace-removal.ts');

describe('the result after an outside change during destroy', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('reports the branch as remaining when an outside writer recreates it right after the delete', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    hook.after = (args, ok) => { if (ok && args[0] === 'update-ref') git(root, 'branch', workspace.branch, first); };
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    expect(JSON.parse(await readFile(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'), 'utf8')))
      .toMatchObject({ phase: 'worktree-removed' });
  });

  // Root ignores directory modes, so the unreadable parent cannot be made there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('reports a failed worktree removal once when the worktree parent turns unreadable', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'lock', workspace.path);
    const worktrees = dirname(workspace.path);
    hook.after = (args, ok) => { if (!ok && args[0] === 'worktree' && args[1] === 'remove') chmodSync(worktrees, 0o000); };
    const { calls, report } = recordingReport();
    try {
      expect(await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, report))
        .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    } finally { chmodSync(worktrees, 0o755); }
    expect(calls).toEqual([['unexplained']]);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  // Root ignores directory modes, so the unreadable parent cannot be made there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('reports a worktree HEAD refusal once when the worktree parent turns unreadable', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(workspace.path, 'checkout', '-q', '--detach');
    const worktrees = dirname(workspace.path);
    hook.afterHead = (refusal) => { if (refusal) chmodSync(worktrees, 0o000); };
    const { calls, report } = recordingReport();
    try {
      expect(await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, report))
        .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    } finally { chmodSync(worktrees, 0o755); }
    expect(calls).toEqual([['unexplained']]);
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  it.runIf(process.platform !== 'win32')('reports the removed worktree as deleted when a check after the removal fails', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    // The worktrees directory turns unreadable once the checkout is gone, so the next check throws.
    const worktrees = dirname(workspace.path);
    hook.after = (args, ok) => { if (ok && args[0] === 'worktree' && args[1] === 'remove') chmodSync(worktrees, 0o000); };
    try {
      expect(await removeOwnedWorkspace(root, workspace)).toEqual({ workerId: workspace.ownerRunId, state: 'incomplete', remaining: ['branch'],
        error: expect.any(String), deleted: [{ kind: 'worktree', path: workspace.path }] });
    } finally { chmodSync(worktrees, 0o755); }
    hook.after = undefined;
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
  });
});

describe('the owned-branch compare-and-swap witnesses (hearsay-tools/squawk#911)', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('keeps the branch when one ref is seen keeping two different commits', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'abandoned');
    git(workspace.path, 'commit', '-qam', 'abandoned');
    git(workspace.path, 'reset', '-q', '--hard', first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'kept');
    git(workspace.path, 'commit', '-qam', 'kept');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    git(root, 'branch', 'keeper', tip);
    git(root, 'worktree', 'remove', workspace.path);
    // Each question finds `keeper` at the commit it asks about, so no single state keeps both.
    hook.beforeContains = (sha) => { execFileSync('git', ['update-ref', 'refs/heads/keeper', sha], { cwd: root }); };
    try {
      expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    } finally { hook.beforeContains = undefined; }
    expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });

  it('keeps the branch when it moves away and back while its kept commits are proven', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'kept');
    git(workspace.path, 'commit', '-qam', 'kept');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    git(root, 'branch', 'keeper', tip);
    git(root, 'worktree', 'remove', workspace.path);
    // The first proof prepares the checkpoint; during the second, right before the delete, an outside
    // writer moves the branch to a commit nothing else keeps and back: same tip, new reflog entries.
    let asked = 0;
    hook.beforeContains = () => {
      if (++asked !== 2) return;
      const away = git(root, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'away');
      git(root, 'update-ref', `refs/heads/${workspace.branch}`, away);
      git(root, 'update-ref', `refs/heads/${workspace.branch}`, tip);
    };
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(asked).toBe(2);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });
});
