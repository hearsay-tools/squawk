import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectMovedMarker } from '../project-paths.ts';
import { describeProcesses } from './process-liveness.ts';
import { createOwnedWorkspace } from './workspace.ts';
import { ownedWorktreePresent, removeOwnedWorkspace } from './workspace-removal.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';

describe('removeOwnedWorkspace verified retryable destruction', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('preserves owned resources when shared mutation coordination is unavailable', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const claims = join(root, '.git/cezar-worktree-mutations');
    await rm(claims, { recursive: true });
    await writeFile(claims, 'coordination unavailable');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    await rm(claims);
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('runs beforeRemove once the removal goes ahead, while the checkout still exists (hearsay-tools/cezarion#781: the preview is released first)', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const seen: boolean[] = [];
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { seen.push(existsSync(workspace.path)); }))
      .toMatchObject({ state: 'complete', remaining: [] });
    expect(seen).toEqual([true]);
  });

  it('never runs beforeRemove when the cleanup declines', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const claims = join(root, '.git/cezar-worktree-mutations');
    await rm(claims, { recursive: true });
    await writeFile(claims, 'coordination unavailable');
    let calls = 0;
    expect(await removeOwnedWorkspace(root, workspace, undefined, async () => { calls += 1; }))
      .toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(calls).toBe(0);
    await rm(claims);
  });

  it('preserves owned resources when cleanup authority is revoked during preflight', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    let attached = true;
    const assertAttached = () => {
      if (!attached) throw new Error('project detached');
      queueMicrotask(() => { attached = false; });
    };

    expect(await removeOwnedWorkspace(root, workspace, assertAttached)).toMatchObject({
      state: 'incomplete', remaining: ['worktree', 'branch'],
    });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(existsSync(receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json'))).toBe(false);
  });

  it('preserves the branch when cleanup authority is revoked after worktree removal', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    let revokedAfterRemoval = false;
    const assertAttached = () => {
      if (!existsSync(workspace.path)) {
        revokedAfterRemoval = true;
        throw new Error('project detached');
      }
    };

    expect(await removeOwnedWorkspace(root, workspace, assertAttached)).toMatchObject({
      state: 'incomplete', remaining: ['branch'],
    });
    expect(revokedAfterRemoval).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it('removes only owned resources, retains the receipt and is idempotent after reopen', async () => {
    const { root, first, parentPath } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    await writeFile(join(workspace.path, 'tracked.txt'), 'worker commit');
    git(workspace.path, 'commit', '-qam', 'worker');
    const result = await removeOwnedWorkspace(root, workspace);
    expect(result).toEqual({ workerId: workspace.ownerRunId, state: 'complete', remaining: [], deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` },
    ] });
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'branch', '--list', workspace.branch)).toBe('');
    expect(existsSync(receiptPath(root, workspace))).toBe(true);
    expect(await removeOwnedWorkspace(root, workspace)).toEqual(result);
    expect(await readFile(join(parentPath, 'tracked.txt'), 'utf8')).toBe('dirty');
  });

  for (const attack of ['symlink', 'moved', 'moved, path reused', 'replacement', 'foreign checkout', 'detached', 'same-tip branch', 'missing identity', 'rewritten reflog', 'symlink reflog', 'resource collision', 'workspace names another baseline'] as const) {
    it(`preserves ambiguous resources: ${attack}`, async () => {
      const { root, first, second } = await fixture();
      const workspace = await createOwnedWorkspace(root, randomUUID(), first);
      const log = join(root, '.git/logs/refs/heads', workspace.branch);
      if (attack === 'symlink') { await rename(workspace.path, workspace.path + '-moved'); await symlink(workspace.path + '-moved', workspace.path); }
      if (attack === 'moved') git(root, 'worktree', 'move', workspace.path, workspace.path + '-moved');
      if (attack === 'moved, path reused') {
        // Another checkout of the task branch now sits at the path, with its own Git admin directory.
        git(workspace.path, 'checkout', '-q', '--detach');
        git(root, 'worktree', 'move', workspace.path, workspace.path + '-moved');
        git(root, 'worktree', 'add', '-q', workspace.path, workspace.branch);
      }
      if (attack === 'replacement') { git(root, 'worktree', 'remove', '--force', workspace.path); git(root, 'worktree', 'add', workspace.path, workspace.branch); }
      if (attack === 'foreign checkout') git(workspace.path, 'checkout', '-qb', 'unowned');
      if (attack === 'detached') git(workspace.path, 'checkout', '--detach');
      if (attack === 'same-tip branch') {
        // The reflog's creation entry identifies the branch (hearsay-tools/cezarion#904). Pin
        // the recreation to another second; a same-second recreation is the spec's named residual.
        git(workspace.path, 'checkout', '--detach'); git(root, 'branch', '-D', workspace.branch);
        execFileSync('git', ['branch', workspace.branch, first], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2021-01-01T00:00:00Z' } });
        git(workspace.path, 'checkout', workspace.branch);
      }
      if (attack === 'missing identity') {
        const receipt = JSON.parse(await readFile(receiptPath(root, workspace), 'utf8')); delete receipt.branchIdentity;
        await writeFile(receiptPath(root, workspace), JSON.stringify(receipt));
      }
      if (attack === 'rewritten reflog') await writeFile(log, 'changed');
      if (attack === 'symlink reflog') { await rename(log, log + '-real'); await symlink(log + '-real', log); }
      const target = attack === 'resource collision' ? { ...workspace, resourceId: randomUUID() }
        : attack === 'workspace names another baseline' ? { ...workspace, baselineSha: second } : workspace;
      const result = await removeOwnedWorkspace(root, target);
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(git(root, 'branch', '--list', workspace.branch)).not.toBe('');
      expect(existsSync(attack === 'moved' ? workspace.path + '-moved' : workspace.path)).toBe(true);
      if (attack === 'moved, path reused') expect(existsSync(workspace.path + '-moved')).toBe(true);
      // hearsay-tools/squawk#910: the refusal names where HEAD went and the command that returns it.
      const fix = `Keep the work you need on ${workspace.branch}, run git -C '${workspace.path}' switch '${workspace.branch}', then retry.`;
      if (attack === 'foreign checkout') expect(result.error).toBe(`Worktree HEAD is on unowned, not on its task branch ${workspace.branch}. ${fix}`);
      if (attack === 'detached') expect(result.error).toBe(`Worktree HEAD is detached at ${first.slice(0, 7)}, not on its task branch ${workspace.branch}. ${fix}`);
    });
  }
});

describe('ownedWorktreePresent', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  // Destroy stops what runs in a worktree only when this proves it is still the owned one.
  it.each([
    ['its provisioned worktree', true],
    ['no receipt', false],
    ['a workspace that names another baseline', false],
    ['a worktree re-added at its path', false],
    ['another worktree at its path after it moved away', false],
    ['a removed worktree', false],
  ] as const)('answers %s with %s', async (shape, expected) => {
    const { root, first, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    if (shape === 'no receipt') await rm(receiptPath(root, workspace));
    if (shape === 'a worktree re-added at its path') {
      // Git reuses the admin directory name, but the new one carries no identity marker.
      git(root, 'worktree', 'remove', '--force', workspace.path);
      git(root, 'worktree', 'add', '-q', workspace.path, workspace.branch);
    }
    if (shape === 'another worktree at its path after it moved away') {
      // The moved checkout keeps the admin directory and its marker; the new one gets another.
      git(root, 'worktree', 'move', workspace.path, workspace.path + '-moved');
      git(root, 'worktree', 'add', '-q', '--detach', workspace.path, first);
    }
    if (shape === 'a removed worktree') git(root, 'worktree', 'remove', workspace.path);
    const target = shape === 'a workspace that names another baseline' ? { ...workspace, baselineSha: second } : workspace;
    expect(await ownedWorktreePresent(root, target)).toBe(expected);
  });
});

describe('removeOwnedWorkspace refusals that keep every resource', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it.runIf(process.platform !== 'win32')('keeps the worktree while a process runs in it, names that process and finishes after it exits', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    const holder = spawn('sleep', ['30'], { cwd: workspace.path, stdio: 'ignore' });
    const exited = new Promise(resolve => holder.once('exit', resolve));
    const held: number[][] = []; let unexplained = 0;
    try {
      const result = await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined,
        { held: pids => { held.push([...pids]); }, unexplained: () => { unexplained += 1; } });
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      expect(result.error).toContain(describeProcesses([holder.pid!]));
      expect({ held, unexplained }).toEqual({ held: [[holder.pid]], unexplained: 0 });
      expect(existsSync(workspace.path)).toBe(true);
      expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
    } finally { holder.kill(); await exited; }
    expect(await removeOwnedWorkspace(root, workspace)).toMatchObject({ state: 'complete', remaining: [] });
  });

  it.runIf(process.platform === 'linux')('keeps the worktree when its processes cannot be listed, and reports the refusal as unexplained', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    // /proc can deny listing (hidepid, a locked-down container): no holder is known, none is ruled out.
    const scope = vi.spyOn(fs, 'readdirSync');
    const scoped = scope.getMockImplementation()!;
    scope.mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (path === '/proc') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (scoped as (path: fs.PathLike, options?: unknown) => unknown)(path, options);
    }) as typeof fs.readdirSync);
    const held: number[][] = []; let unexplained = 0;
    const result = await removeOwnedWorkspace(root, workspace, undefined, undefined, undefined,
      { held: pids => { held.push([...pids]); }, unexplained: () => { unexplained += 1; } });
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect({ held, unexplained }).toEqual({ held: [], unexplained: 1 });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });

  it('keeps a worker workspace left in the read-only data of a moved project', async () => {
    const { root, first } = await fixture();
    // A project that still wrote .ai/cezar/ when the worker was provisioned, then moved to .ai/squawk/.
    await mkdir(join(root, '.ai', 'cezar'), { recursive: true });
    const workspace = await createOwnedWorkspace(root, randomUUID(), first);
    expect(workspace.path.split(sep)).toContain('cezar');
    const marker = projectMovedMarker(root)!;
    await mkdir(dirname(marker.path), { recursive: true });
    await writeFile(marker.path, JSON.stringify({ root: marker.root }));
    expect(await removeOwnedWorkspace(root, workspace)).toEqual({ workerId: workspace.ownerRunId, state: 'incomplete',
      remaining: ['worktree', 'branch'], error: expect.stringContaining('read-only project data') });
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(root, 'rev-parse', workspace.branch)).toBe(first);
  });
});
