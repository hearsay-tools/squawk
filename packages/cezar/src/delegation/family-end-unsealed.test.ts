import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { projectPaths } from '../project-paths.ts';
import { RunStore } from '../runs/store.ts';
import { releaseEndedWorkerBranches } from './family-end.ts';
import { createOwnedWorkspace } from './workspace.ts';
import { fixture, git } from './workspace-fixture.testkit.ts';

// This file seals no removal slot. A worker family end removes an orphan receipt's clean worktree
// and its branch without a run to ask the slots about, so it checks the seal first
// (spec 2026-11-21-run-lifecycle-and-store-ports, "Removal cases", last row). `family-end.test.ts`
// shows the same orphan removed in a sealed process.
const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

it('a worker family end throws and keeps an orphan receipt\'s clean worktree and its branch', async () => {
  const { root, first } = await fixture();
  const orphan = await createOwnedWorkspace(root, randomUUID(), first);
  const store = RunStore.open(projectPaths(root).write);
  stores.push(store);

  await expect(releaseEndedWorkerBranches(root, store, () => () => undefined))
    .rejects.toThrow(/No removal slot is registered: call registerBuiltInRunSlots\(\)/);
  expect(existsSync(orphan.path)).toBe(true);
  expect(git(root, 'branch', '--list', orphan.branch)).not.toBe('');
});
