import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import * as gitReads from './git.ts';
import { commit, git } from './repo-branches.testkit.ts';
import { readRepo, forgetRepoRead } from './repo-read-cache.ts';
import { cachedWorktreeSizeBytes, clearWorktreeSizeCacheForTests, forgetWorktreeSize } from './worktree-size-cache.ts';
import { worktreeSizeBytes } from '../git-worktree.ts';

vi.mock('../git-worktree.ts', async (original) => ({ ...await original<typeof import('../git-worktree.ts')>(), worktreeSizeBytes: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); clearWorktreeSizeCacheForTests(); });

it('coalesces size reads, bounds du concurrency, expires and invalidates entries', async () => {
  vi.useFakeTimers();
  let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
  let unblock!: () => void;
    const release = new Promise<void>((resolve) => { unblock = resolve; });
  let active = 0;
  let peak = 0;
  vi.mocked(worktreeSizeBytes).mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    if (active === 6) start();
    await release;
    active--;
    return 42;
  });
  const reads = Array.from({ length: 10 }, (_, i) => cachedWorktreeSizeBytes(`p${i}`));
  const duplicate = cachedWorktreeSizeBytes('p0');
  await started;
  expect(worktreeSizeBytes).toHaveBeenCalledTimes(6);
  unblock();
  expect(await Promise.all([...reads, duplicate])).toEqual(Array(11).fill(42));
  expect(peak).toBe(6);
  await cachedWorktreeSizeBytes('p0');
  expect(worktreeSizeBytes).toHaveBeenCalledTimes(10);
  vi.advanceTimersByTime(30_001);
  await cachedWorktreeSizeBytes('p0');
  forgetWorktreeSize('p0');
  await cachedWorktreeSizeBytes('p0');
  expect(worktreeSizeBytes).toHaveBeenCalledTimes(12);
});

it('keeps status fresh, coalesces ref reads and detects external commits and branches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-read-'));
  const home = Home.sandbox(join(root, 'home'));
  const queries = { listBranchOwners: () => [] };
  const logRead = vi.spyOn(gitReads, 'getLogWithParents');
  try {
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
    await Promise.all([readRepo(root, home, queries), readRepo(root, home, queries)]);
    expect(logRead).toHaveBeenCalledTimes(1);
    writeFileSync(join(root, 'new.txt'), 'new');
    expect((await readRepo(root, home, queries)).status).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'new.txt' })]));
    expect(logRead).toHaveBeenCalledTimes(1);
    await commit(root, 'base.txt', 'changed');
    await git(root, 'branch', 'external');
    const changed = await readRepo(root, home, queries);
    expect(logRead).toHaveBeenCalledTimes(2);
    expect(changed.branches).toContain('external');
    forgetRepoRead(root);
    await readRepo(root, home, queries);
    expect(logRead).toHaveBeenCalledTimes(3);
  } finally { forgetRepoRead(root); rmSync(root, { recursive: true, force: true }); }
});
