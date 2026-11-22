import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { acceptanceOver } from './continuation-acceptance-fakes.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

// Session affinity and model presets read the runner definitions, as the engine fixture registered them.
registerRunner(claudeRunner);

const roots: string[] = [];
const stores: RunStore[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-unarchive-')); roots.push(root);
  const store = RunStore.open(join(root, '.ai/cezar')); stores.push(store);
  const manager = acceptanceOver(store, root);
  return { store, manager };
}

function archivedFinished(store: RunStore) {
  const run = store.createRun({
    title: 'task', task: 'task', workflow: 'original',
    steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
  });
  store.updateStep(run.id, 'work', { status: STEP_STATUS.done, sessionId: 'old-session' });
  setRunStatus(store, run.id, RUN_STATUS.done);
  store.archive.setArchived(run.id, true);
  return run;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('continueRun unarchives', () => {
  it.each([
    { name: 'human Continue', defer: false, status: RUN_STATUS.running },
    { name: 'deferred restart recovery', defer: true, status: RUN_STATUS.queued },
  ])('$name on an archived run clears archived and archivedAt', ({ defer, status }) => {
    const { store, manager } = fixture();
    const run = archivedFinished(store);
    expect(store.getRun(run.id)).toMatchObject({ archived: true });
    expect(store.getRun(run.id)?.archivedAt).toBeDefined();

    expect(manager.continueRun(run.id, { text: 'keep going' }, defer)).toEqual({ ok: true });

    const after = store.getRun(run.id);
    expect(after?.archived).toBe(false);
    expect(after?.archivedAt).toBeUndefined();
    expect(after?.status).toBe(status);
    expect(after?.pinned).toBeUndefined();
  });

  it('a refused Continue leaves the run archived', () => {
    const { store, manager } = fixture();
    const run = store.createRun({
      title: 'task', task: 'task', workflow: 'original',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateStep(run.id, 'work', { status: STEP_STATUS.done });
    setRunStatus(store, run.id, RUN_STATUS.done);
    store.archive.setArchived(run.id, true);

    expect(manager.continueRun(run.id, { text: 'keep going' })).toMatchObject({ ok: false });
    expect(store.getRun(run.id)?.archived).toBe(true);
    expect(store.getRun(run.id)?.archivedAt).toBeDefined();
  });

  it('a refused worker continuation checkpoint leaves the run archived', () => {
    const { store, manager } = fixture();
    const parent = store.createRun({
      title: 'parent', task: 'parent', workflow: 'original',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const worker = store.createOwnedRun(
      { title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] },
      parent.id, randomUUID(),
      { role: 'worker', permissions: [], parentRunId: parent.id, workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40),
      } },
      'a'.repeat(64),
      spawnCapacityRefusal,
    );
    store.updateStep(worker.id, 'task', { status: STEP_STATUS.done, sessionId: 'old-session' });
    setRunStatus(store, worker.id, RUN_STATUS.done);
    store.archive.setArchived(worker.id, true);
    const commit = vi.spyOn(store, 'commitWorkerContinuation').mockImplementation(() => {
      throw new Error('checkpoint failed');
    });

    expect(manager.continueRun(worker.id, { text: 'keep going' })).toMatchObject({ ok: false });
    // The refusal is the checkpoint's, after admission passed.
    expect(commit).toHaveBeenCalledOnce();
    expect(store.getRun(worker.id)?.archived).toBe(true);
    expect(store.getRun(worker.id)?.archivedAt).toBeDefined();
    commit.mockRestore();
  });
});
