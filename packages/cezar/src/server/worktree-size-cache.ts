import { inspectWorktreeReclaimBlocker, worktreeSizeBytes } from '../git-worktree.ts';
import { boundedReadCache, readQueue } from './bounded-read-cache.ts';

const sizes = boundedReadCache<number | null>(30_000, 512);
const queue = readQueue(6);
const blockerQueue = readQueue(6);
export const cachedWorktreeSizeBytes = (path: string) => sizes.read(path, () => queue(() => worktreeSizeBytes(path)));
export const queuedWorktreeReclaimBlocker = (repoRoot: string, path: string) =>
  blockerQueue(() => inspectWorktreeReclaimBlocker(repoRoot, path));
export const forgetWorktreeSize = (path: string) => sizes.forget(path);
export const clearWorktreeSizeCacheForTests = () => sizes.clear();
