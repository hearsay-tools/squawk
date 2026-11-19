// hearsay-tools/squawk#3553: an explicit destroy of a worker that holds work refuses before it
// changes anything; `discardWork` deletes the work, and the pending destroy keeps that approval.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { betweenAttempts, cadence, destroyOf, f, settled, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

describe('explicit destroy of a worker that holds work', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  it('refuses, names the work and records no destroy, so the worker stays as it was', async () => {
    await cadence();
    const { workerId, workspace } = await settled(false);
    writeFileSync(join(workspace.path, 'notes.txt'), 'unsaved');
    const status = f.store.getRun(workerId)!.status;
    const result = await f.service.destroy(f.caller, { workerId });
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'], work: { uncommittedFiles: 1, commits: 0 } });
    expect(result.error).toMatch(/^Worker [0-9a-f]{8} holds work destroy would delete: 1 uncommitted file\. .*--discard-work/);
    expect(destroyOf(workerId)).toBeUndefined();
    expect(f.store.getRun(workerId)!.status).toBe(status);
    expect(existsSync(join(workspace.path, 'notes.txt'))).toBe(true);
  });

  it('deletes the work with discardWork, through the human route too', async () => {
    await cadence();
    const { workerId, workspace } = await settled(false);
    writeFileSync(join(workspace.path, 'notes.txt'), 'unsaved');
    expect(await f.service.destroyForHuman('project', workerId, { discardWork: true })).toMatchObject({ state: 'complete', remaining: [] });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('keeps the approval on the pending destroy, so an automatic retry finishes the discard', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace, blocker } = await settled();
    writeFileSync(join(workspace.path, 'notes.txt'), 'unsaved');
    expect(await f.service.destroy(f.caller, { workerId }, { discardWork: true })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(await betweenAttempts(workerId, () => destroyOf(workerId))).toMatchObject({ phase: 'incomplete', discardWork: true });
    blocker!.release();
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('refuses in the checked removal when work appears after the first check, and stores the refusal', async () => {
    await cadence();
    const { workerId, workspace } = await settled(false);
    // The worker's own teardown writes a file after the first check, as a live worker may.
    const { workspaceKinds } = await import('./workspace-kinds.ts');
    vi.spyOn(workspaceKinds['owned-isolated'], 'teardown').mockImplementation(async () => { writeFileSync(join(workspace.path, 'late.txt'), 'late'); return undefined; });
    const result = await f.service.destroy(f.caller, { workerId });
    expect(result).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'], work: { uncommittedFiles: 1, commits: 0 } });
    expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', error: result.error });
    expect(existsSync(join(workspace.path, 'late.txt'))).toBe(true);
  });
});
