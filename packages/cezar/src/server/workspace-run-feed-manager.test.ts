import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { makeTimerWait } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { describe, expect, it } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-no-runner.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createWorkspaceRunFeed } from './workspace-run-feed.ts';

/**
 * The run manager subscribes to its store's lifecycle when it is built, before any feed connects.
 * Its family reconciler cancels a terminal run's open waits in a write nested inside the publish
 * of the status write, so the feed hears that write first and then the status write, and both
 * frames carry the record with its waits cancelled, as the store emitter's feed sent them.
 */
describe('workspace run feed beside a run manager (hearsay-tools/squawk#4030)', () => {
  it('sends a run that failed with an open wait with its waits cancelled, in both frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-feed-manager-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    try {
      createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
      const run = store.createRun({ title: 'waits', workflow: 'quick-task', task: 'wait', steps: [] });
      setRunStatus(store, run.id, RUN_STATUS.running);
      store.commitWait(run.id, makeTimerWait());
      expect(store.getRun(run.id)?.waits).toHaveLength(1);
      const feed = createWorkspaceRunFeed({
        bootStore: store,
        contexts: { ids: () => [], peek: () => undefined, onContextBuilt: () => () => {} },
        onWorkspaceEvent: () => () => {},
        onUsage: () => () => {},
        allUsage: () => ({}),
        withLiveUsage: (summary) => summary,
      });
      const frames: string[] = [];
      const detach = feed.connect('boot', 'full', (event, data) => { if (event === 'run') frames.push(data); });
      setRunStatus(store, run.id, RUN_STATUS.failed);
      detach();
      const settled = store.getRun(run.id)!;
      expect(settled.status).toBe(RUN_STATUS.failed);
      expect(settled.waits ?? []).toEqual([]);
      const current = JSON.stringify({ ...settled, project: 'boot' });
      expect(frames).toEqual([current, current]);
    } finally {
      await drainFixtureManagers(root);
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
