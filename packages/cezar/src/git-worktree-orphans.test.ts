import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorktree, pruneOrphans } from './git-worktree.ts';
import { projectPaths } from './project-paths.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cezar-orphans-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function tip(root: string, branch: string): Promise<string | null> {
  return run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root })
    .then(({ stdout }) => stdout.trim(), () => null);
}

async function commitIn(path: string, file: string): Promise<void> {
  writeFileSync(join(path, file), `${file}\n`);
  await run('git', ['add', '-A'], { cwd: path });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', file], { cwd: path });
}

// A missing run record alone never permits a delete (hearsay-tools/cezarion#2272). Every case
// passes an empty run set: the store that a deleted `runs.db` reopens as.
describe('pruneOrphans keeps work no other ref holds', () => {
  it('keeps an orphan with uncommitted files, and its branch', async () => {
    const root = await repo();
    const wt = await createWorktree(root, 'dirty0000000', 'main');
    writeFileSync(join(wt.path, 'base.txt'), 'edited\n');
    writeFileSync(join(wt.path, 'new.txt'), 'untracked\n');

    await expect(pruneOrphans(root, new Set())).resolves.toEqual([]);

    expect(readFileSync(join(wt.path, 'base.txt'), 'utf8')).toBe('edited\n');
    expect(readFileSync(join(wt.path, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(await tip(root, wt.branch)).not.toBeNull();
  });

  it('keeps the branch of a clean orphan whose commits are not on any other ref', async () => {
    const root = await repo();
    const wt = await createWorktree(root, 'ahead0000000', 'main');
    await commitIn(wt.path, 'work.txt');
    const sha = await tip(root, wt.branch);

    // The checkout goes (its branch keeps HEAD, the reclaim rule); the branch stays.
    await expect(pruneOrphans(root, new Set())).resolves.toEqual(['ahead0000000']);

    expect(existsSync(wt.path)).toBe(false);
    expect(await tip(root, wt.branch)).toBe(sha);
  });

  it('removes a clean orphan whose branch is on the base, with its branch', async () => {
    const root = await repo();
    const wt = await createWorktree(root, 'landed000000', 'main');

    await expect(pruneOrphans(root, new Set())).resolves.toEqual(['landed000000']);

    expect(existsSync(wt.path)).toBe(false);
    expect(await tip(root, wt.branch)).toBeNull();
  });

  it('removes a branch whose commits another branch also holds', async () => {
    const root = await repo();
    const wt = await createWorktree(root, 'copied000000', 'main');
    await commitIn(wt.path, 'work.txt');
    await run('git', ['branch', 'keeper', wt.branch], { cwd: root });

    await expect(pruneOrphans(root, new Set())).resolves.toEqual(['copied000000']);

    expect(await tip(root, wt.branch)).toBeNull();
    expect(await tip(root, 'keeper')).not.toBeNull();
  });

  it('keeps a held branch that another worktree has checked out', async () => {
    const root = await repo();
    const wt = await createWorktree(root, 'moved0000000', 'main');
    // The orphan checkout left its task branch; an ordinary worktree took it.
    await run('git', ['switch', '-q', '--detach'], { cwd: wt.path });
    const other = join(root, 'other');
    await run('git', ['worktree', 'add', '-q', other, wt.branch], { cwd: root });

    await expect(pruneOrphans(root, new Set())).resolves.toEqual(['moved0000000']);

    expect(existsSync(wt.path)).toBe(false);
    expect(await tip(root, wt.branch)).not.toBeNull();
    const head = await run('git', ['symbolic-ref', 'HEAD'], { cwd: other });
    expect(head.stdout.trim()).toBe(`refs/heads/${wt.branch}`);
    await expect(run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: other })).resolves.toBeTruthy();
  });

  it('sorts a mixed set over an empty run store, and keeps live runs untouched', async () => {
    const root = await repo();
    const dirty = await createWorktree(root, 'mixdirty0000', 'main');
    writeFileSync(join(dirty.path, 'new.txt'), 'untracked\n');
    const ahead = await createWorktree(root, 'mixahead0000', 'main');
    await commitIn(ahead.path, 'work.txt');
    const landed = await createWorktree(root, 'mixlanded000', 'main');
    const live = await createWorktree(root, 'mixlive00000', 'main');

    const removed = await pruneOrphans(root, new Set(['mixlive00000']));

    expect(removed.sort()).toEqual(['mixahead0000', 'mixlanded000']);
    expect(existsSync(dirty.path)).toBe(true);
    expect(existsSync(live.path)).toBe(true);
    expect(await tip(root, dirty.branch)).not.toBeNull();
    expect(await tip(root, ahead.branch)).not.toBeNull();
    expect(await tip(root, landed.branch)).toBeNull();
    expect(await tip(root, live.branch)).not.toBeNull();
  });

  it('removes an empty leftover directory and keeps one with files that is not a worktree', async () => {
    const root = await repo();
    const worktrees = join(projectPaths(root).write, 'worktrees');
    mkdirSync(join(worktrees, 'empty0000000'), { recursive: true });
    mkdirSync(join(worktrees, 'files0000000'), { recursive: true });
    writeFileSync(join(worktrees, 'files0000000', 'notes.txt'), 'keep\n');

    await expect(pruneOrphans(root, new Set())).resolves.toEqual(['empty0000000']);

    expect(existsSync(join(worktrees, 'empty0000000'))).toBe(false);
    expect(readFileSync(join(worktrees, 'files0000000', 'notes.txt'), 'utf8')).toBe('keep\n');
  });
});
