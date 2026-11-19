import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedWorkspace } from './workspace.ts';
import { removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('retries branch-only cleanup after a locked ref; rejects repurposing after partial cleanup', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    // A commit no other ref keeps: the explicit destroy that discarded it and removed the checkout
    // still deletes it on a plain retry, which its checkpoint records (hearsay-tools/squawk#3553).
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker');
    git(workspace.path, 'commit', '-qam', 'worker');
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock');
    await writeFile(lock, 'test lock');
    expect(await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined, { discardWork: true }))
      .toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(existsSync(workspace.path)).toBe(false);
    await rm(lock);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    git(root, 'branch', workspace.branch, first);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
  });

  it('refuses changed branch tip and checkout elsewhere after partial removal', async () => {
    const { root, first, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    git(root, 'branch', '-f', workspace.branch, second);
    const commits = Number(git(root, 'rev-list', '--count', `${first}..${second}`));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'],
      error: `Owned branch ${workspace.branch} holds ${commits} commit${commits === 1 ? '' : 's'} beyond the tip destroy recorded; ` +
        'keep what you need, delete the branch, then retry destroy' }); // hearsay-tools/squawk#910
    git(root, 'worktree', 'add', join(root, 'other-checkout'), workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(second);
  });

  it.each(['prepared', 'worktree-removed'])('replays a durable %s checkpoint after directory removal', async phase => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    const checkpoint = JSON.parse(await readFile(path, 'utf8')); checkpoint.phase = phase;
    await writeFile(path, JSON.stringify(checkpoint));
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it.each(['malformed', 'symlink', 'retargeted workspace', 'retargeted Git directory'])('refuses a %s private cleanup checkpoint before deletion', async shape => {
    const { root, first, second } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    if (shape === 'malformed') await writeFile(path, '{}', { mode: 0o600 });
    else if (shape === 'symlink') { const target = join(root, 'outside-checkpoint'); await writeFile(target, '{}'); await symlink(target, path); }
    else {
      // A valid checkpoint from an interrupted attempt, then rewritten to name other resources.
      await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('preview release failed'); });
      const checkpoint = JSON.parse(await readFile(path, 'utf8'));
      if (shape === 'retargeted workspace') checkpoint.workspace.baselineSha = second;
      else checkpoint.gitDir = join(root, '.git', 'worktrees', 'elsewhere');
      await writeFile(path, JSON.stringify(checkpoint));
    }
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  // After a partial removal the checkout is gone and only the branch remains, with its tip recorded.
  async function partlyRemoved() {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] }); await rm(lock);
    return { root, first, workspace };
  }

  it('keeps a partly removed branch another worktree checked out at the recorded tip, and keeps it', async () => {
    const { root, first, workspace } = await partlyRemoved();
    const other = join(root, 'other-checkout');
    git(root, 'worktree', 'add', '-q', other, workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace))
      .toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(workspace.branch);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  it('keeps a partly removed branch that moved away and back, since its reflog holds a commit nothing else keeps', async () => {
    const { root, first, workspace } = await partlyRemoved();
    const away = git(root, 'commit-tree', `${first}^{tree}`, '-p', first, '-m', 'work');
    git(root, 'update-ref', `refs/heads/${workspace.branch}`, away);
    git(root, 'update-ref', `refs/heads/${workspace.branch}`, first);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    expect(git(root, 'reflog', '--format=%H', workspace.branch)).toContain(away);
  });

  // A refusal on a present checkout writes nothing and reports nothing: the checkout is not the
  // owned one, or the checkpoint no longer matches it.
  it.each(['re-added at the worker path after a partial removal', 'whose branch moved after an interrupted destroy',
    'whose branch moved away and back after an interrupted destroy', 'whose branch ref file was rewritten after an interrupted destroy'] as const)(
    'keeps a checkout %s', async how => {
      const { root, first, second } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
      if (how === 're-added at the worker path after a partial removal') {
        const lock = join(root, '.git/refs/heads', workspace.branch + '.lock'); await writeFile(lock, 'lock');
        expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ remaining: ['branch'] }); await rm(lock);
        git(root, 'worktree', 'add', '-q', workspace.path, workspace.branch);
      } else {
        await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('preview release failed'); });
        if (how !== 'whose branch ref file was rewritten after an interrupted destroy') {
          await writeFile(join(workspace.path, 'tracked.txt'), 'worker'); git(workspace.path, 'commit', '-qam', 'worker');
        }
        // Back at the recorded tip: the worker commit survives only in the branch reflog.
        if (how === 'whose branch moved away and back after an interrupted destroy') git(workspace.path, 'reset', '-q', '--hard', first);
        // An outside writer replaces the loose ref without a reflog entry.
        if (how === 'whose branch ref file was rewritten after an interrupted destroy') await writeFile(join(root, '.git/refs/heads', workspace.branch), `${second}\n`);
      }
      const tip = git(root, 'rev-parse', workspace.branch);
      const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
      const checkpoint = await readFile(path, 'utf8');
      expect(await removeOwnedWorkspace(root, workspace))
        .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(await readFile(path, 'utf8')).toBe(checkpoint);
      expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip);
      expect(git(root, 'rev-parse', workspace.branch)).toBe(tip);
    });

  it('keeps a worktree moved after an interrupted destroy', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('preview release failed'); });
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    const checkpoint = await readFile(path, 'utf8');
    git(root, 'worktree', 'move', workspace.path, workspace.path + '-moved');
    expect(await removeOwnedWorkspace(root, workspace))
      .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(await readFile(path, 'utf8')).toBe(checkpoint);
    expect(git(workspace.path + '-moved', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(workspace.branch);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  it('finishes a partly removed destroy after a human deleted the branch', async () => {
    const { root, workspace } = await partlyRemoved();
    git(root, 'branch', '-D', workspace.branch);
    expect(await removeOwnedWorkspace(root, workspace)).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [], deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` }] });
  });

  it('reports a path recreated after a completed destroy and leaves it in place', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
    await mkdir(workspace.path); await writeFile(join(workspace.path, 'cache'), 'keep');
    expect(await removeOwnedWorkspace(root, workspace)).toEqual({ workerId: workspace.ownerRunId, state: 'incomplete', remaining: ['worktree'],
      error: expect.any(String), deleted: [{ kind: 'branch', ref: `refs/heads/${workspace.branch}` }] });
    expect(await readFile(join(workspace.path, 'cache'), 'utf8')).toBe('keep');
  });

  it('never recursively removes a locked worktree and can retry after unlock', async () => {
    const { root, first } = await fixture(); const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    git(root, 'worktree', 'lock', workspace.path);
    expect(await removeOwnedWorkspace(root, workspace))
      .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(JSON.parse(await readFile(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'), 'utf8'))).toMatchObject({ phase: 'prepared' });
    expect(existsSync(workspace.path)).toBe(true); git(root, 'worktree', 'unlock', workspace.path);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete' });
  });
});
