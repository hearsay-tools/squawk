import { testHome } from '../home/test-home.testkit.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-no-runner.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { launchAutomationRun, launchScheduledRun } from './task-template.ts';
import { candidate, definition, occurrence, scheduled } from './task-template.testkit.ts';

describe('automation task templates', () => {
  it.each(['github', 'schedule', 'once'])('copies completion controls to a %s task and ignores a saved variant count greater than one', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-completion-template-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
    // These queued tasks exercise saved options, without invoking the title model.
    vi.stubEnv('CEZ_AUTONAME', '0');
    try {
      const choices: Array<{ archiveWhenDone?: boolean; autoMergePr?: boolean; allowWorkers?: boolean; allowMessaging?: boolean }> = [{}, { archiveWhenDone: true }, { autoMergePr: true }, { archiveWhenDone: true, autoMergePr: true }, { archiveWhenDone: false, autoMergePr: false },
        { allowWorkers: false }, { allowMessaging: false }];
      for (const [index, completion] of choices.entries()) {
        const receiptId = `completion-${index}`;
        const task = { variants: 2 as const, ...completion };
        const launch = () => kind === 'github'
          ? launchAutomationRun({ root, manager, store, definition: { ...definition, task: { ...definition.task, ...task } },
            candidate: { ...candidate, number: candidate.number + index, url: `https://github.com/acme/demo/issues/${candidate.number + index}` }, receiptId,
          })
          : launchScheduledRun({ root, manager, store,
            definition: { ...scheduled, ...(kind === 'once' ? { schedule: { type: 'once' as const, at: '2030-01-15T09:00', timeZone: 'UTC' } } : {}), task: { ...scheduled.task, ...task } },
            occurrence, receiptId, projectName: 'demo', timeZone: 'UTC',
          });
        const launched = await launch();
        const runs = store.listRuns().filter((run) => (run.automation ?? run.automationTrigger)?.receiptId === receiptId);
        expect(runs).toHaveLength(1);
        expect(runs.some((run) => run.id === launched.runId)).toBe(true);
        for (const run of runs) {
          expect(run.archiveWhenDone).toBe(completion.archiveWhenDone);
          expect(run.autoMergePr).toBe(completion.autoMergePr);
          // hearsay-tools/cezarion#2784: an omitted switch launches on.
          expect(run).toMatchObject({ allowWorkers: completion.allowWorkers ?? true, allowMessaging: completion.allowMessaging ?? true });
        }
      }
    } finally {
      try {
        await drainFixtureManagers(root);
        store.close();
        await rm(root, { recursive: true, force: true });
      } finally { vi.unstubAllEnvs(); }
    }
  });

  // Review of #1465: a crash right after the task row commits must still leave its receipt on
  // that row, or reconciliation reads launch-error and a retry starts a second task.
  it('commits the receipt provenance in the task row that creates the run (#1465)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-template-'));
    try {
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = createFixtureManager(store, root);
      const created = vi.spyOn(store, 'createRun');
      // Every later write fails: the process "crashes" right after the creating commit.
      vi.spyOn(store, 'updateRun').mockImplementation(() => { throw new Error('crash after create'); });
      // Review of #1469: the task exists, so the launch succeeded. Answering with its run keeps the
      // receipt from becoming a launch-error that Retry would turn into a second task.
      const scheduledLaunch = await launchScheduledRun({ root, manager, store, definition: scheduled, occurrence, receiptId: 'receipt', projectName: 'demo', timeZone: 'UTC' });
      const runId = created.mock.results[0]?.value.id as string;
      expect(scheduledLaunch).toEqual({ runId });
      expect(store.getRun(runId)?.automationTrigger).toMatchObject({ automationId: 'nightly', receiptId: 'receipt' });
      created.mockClear();
      const githubLaunch = await launchAutomationRun({ root, manager, store, definition: { ...definition, task: { ...definition.task, workflow: 'quick-task' } }, candidate, receiptId: 'gh-receipt' });
      const githubRunId = created.mock.results[0]?.value.id as string;
      expect(githubLaunch).toMatchObject({ runId: githubRunId });
      expect(store.getRun(githubRunId)?.automation).toMatchObject({ automationId: 'one', receiptId: 'gh-receipt' });
      vi.restoreAllMocks();
      await drainFixtureManagers(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Review of #1469: a launch that answers a run must leave that run queued, not a row that only
  // a restart would start.
  it('a write that throws after the creating commit still leaves the answered run queued', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-template-'));
    try {
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = createFixtureManager(store, root);
      vi.spyOn(store, 'updateRun').mockImplementationOnce(() => { throw new Error('crash after create'); });
      const { runId } = await launchScheduledRun({ root, manager, store, definition: scheduled, occurrence, receiptId: 'receipt', projectName: 'demo', timeZone: 'UTC' });
      expect(manager.isActive(runId)).toBe(true);
      vi.restoreAllMocks();
      manager.cancel(runId);
      await drainFixtureManagers(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
