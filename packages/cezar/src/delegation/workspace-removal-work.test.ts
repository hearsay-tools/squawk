// hearsay-tools/squawk#3553: an explicit destroy refuses, naming it, to delete uncommitted changes
// or unlanded commits, unless its caller allows the discard.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { fixture, git, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { describeWork, workspaceWork } from './workspace-work.ts';

async function worker() {
  const { root, first } = await fixture();
  const workspace = await createOwnedWorkspace(root, randomUUID(), first);
  return { root, first, workspace };
}
const branchExists = (root: string, branch: string) => git(root, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) !== '';

describe('explicit destroy of a worker that holds work', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it.each([
    ['an untracked file', async (path: string) => { await writeFile(join(path, 'new.txt'), 'new'); }, { uncommittedFiles: 1, commits: 0 }],
    ['a modified and a staged file', async (path: string) => {
      await writeFile(join(path, 'tracked.txt'), 'changed');
      await writeFile(join(path, 'staged.txt'), 'staged'); git(path, 'add', 'staged.txt');
    }, { uncommittedFiles: 2, commits: 0 }],
    ['a staged rename', async (path: string) => { git(path, 'mv', 'tracked.txt', 'moved.txt'); }, { uncommittedFiles: 1, commits: 0 }],
    ['two commits no other branch reaches', async (path: string) => {
      for (const n of [1, 2]) { await writeFile(join(path, 'tracked.txt'), `worker ${n}`); git(path, 'commit', '-qam', `worker ${n}`); }
    }, { uncommittedFiles: 0, commits: 2 }],
    ['a commit only the reflog keeps', async (path: string) => {
      const base = git(path, 'rev-parse', 'HEAD');
      await writeFile(join(path, 'tracked.txt'), 'worker'); git(path, 'commit', '-qam', 'worker');
      git(path, 'reset', '-q', '--hard', base);
    }, { uncommittedFiles: 0, commits: 1 }],
  ])('refuses with %s, names it and keeps the worktree and branch', async (_name, change, expected) => {
    const { root, workspace } = await worker();
    await change(workspace.path);
    expect(await workspaceWork(root, workspace)).toEqual(expected);
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'], work: expected, error: describeWork(workspace.ownerRunId, expected) });
    expect(result.error).toContain('--discard-work');
    expect(existsSync(workspace.path)).toBe(true);
    expect(branchExists(root, workspace.branch)).toBe(true);
    // The refusal leaves no cleanup checkpoint behind: a later plain destroy checks again.
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', work: expected });
  });

  it('refuses, naming it, a file written after the work check and before the removal', async () => {
    const { root, workspace } = await worker();
    const late = () => writeFile(join(workspace.path, 'late.txt'), 'late');
    expect(await removeOwnedWorkspace(root, workspace, undefined, late)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'],
      work: { uncommittedFiles: 1, commits: 0 } });
    expect(existsSync(join(workspace.path, 'late.txt'))).toBe(true);
    expect(branchExists(root, workspace.branch)).toBe(true);
  });

  it('deletes uncommitted changes and unlanded commits when the discard is allowed', async () => {
    const { root, workspace } = await worker();
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker'); git(workspace.path, 'commit', '-qam', 'worker');
    await writeFile(join(workspace.path, 'new.txt'), 'new');
    const result = await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, { discardWork: true });
    expect(result).toMatchObject({ state: 'complete', remaining: [] });
    expect(result.work).toBeUndefined();
    expect(existsSync(workspace.path)).toBe(false);
    expect(branchExists(root, workspace.branch)).toBe(false);
  });

  it.each([
    ['no change', async () => {}],
    ['only an ignored file', async (path: string, root: string) => {
      await appendFile(join(root, '.git', 'info', 'exclude'), '\nignored.txt\n');
      await writeFile(join(path, 'ignored.txt'), 'build output');
    }],
    ['a commit another branch keeps', async (path: string, root: string) => {
      await writeFile(join(path, 'tracked.txt'), 'worker'); git(path, 'commit', '-qam', 'worker');
      git(root, 'branch', 'landed', git(path, 'rev-parse', 'HEAD'));
    }],
  ])('completes without a prompt with %s', async (_name, change) => {
    const { root, workspace } = await worker();
    await change(workspace.path, root);
    expect(await workspaceWork(root, workspace)).toBeUndefined();
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false);
    expect(branchExists(root, workspace.branch)).toBe(false);
  });

  it('names stranded commits once the worktree is gone, and deletes them when the discard is allowed', async () => {
    const { root, workspace } = await worker();
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker'); git(workspace.path, 'commit', '-qam', 'worker');
    git(root, 'worktree', 'remove', '--force', workspace.path);
    const expected = { uncommittedFiles: 0, commits: 1 };
    expect(await workspaceWork(root, workspace)).toEqual(expected);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'], work: expected,
      error: describeWork(workspace.ownerRunId, expected) });
    expect(branchExists(root, workspace.branch)).toBe(true);
    expect(await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, { discardWork: true }))
      .toMatchObject({ state: 'complete', remaining: [] });
    expect(branchExists(root, workspace.branch)).toBe(false);
  });
});

describe('explicit destroy retries after a failed branch delete', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  async function removedWithKeeper() {
    const { root, workspace } = await worker();
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker'); git(workspace.path, 'commit', '-qam', 'worker');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    git(root, 'branch', 'keeper', tip);
    // A held ref lock makes the branch delete fail after the checkout is gone.
    const lock = join(root, '.git/refs/heads', `${workspace.branch}.lock`);
    await writeFile(lock, 'held');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(existsSync(workspace.path)).toBe(false);
    await rm(lock);
    git(root, 'branch', '-D', 'keeper');
    return { root, workspace, tip };
  }

  it('proves the keepers again when the first attempt found no work, and refuses once they are gone', async () => {
    const { root, workspace, tip } = await removedWithKeeper();
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'], work: { uncommittedFiles: 0, commits: 1 } });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
  });

  it('deletes the branch on a retry that allows the discard', async () => {
    const { root, workspace } = await removedWithKeeper();
    expect(await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, { discardWork: true })).toMatchObject({ state: 'complete', remaining: [] });
    expect(branchExists(root, workspace.branch)).toBe(false);
  });
});

describe('describeWork', () => {
  it('names each kind of work with its count and both ways forward', () => {
    expect(describeWork('12345678-aaaa-4bbb-8ccc-dddddddddddd', { uncommittedFiles: 1, commits: 3 })).toBe(
      'Worker 12345678 holds work destroy would delete: 1 uncommitted file and 3 commits no other branch reaches. ' +
      'Land or commit what you need and rerun destroy, or rerun destroy with --discard-work to delete it');
    expect(describeWork('12345678-aaaa-4bbb-8ccc-dddddddddddd', { uncommittedFiles: 2, commits: 0 })).toContain(': 2 uncommitted files. ');
  });
});
