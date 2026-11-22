import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { retainAutosaveCleanup, clearAutosaveCleanup } from '../autosave-cleanup.ts';
import { runPersistence } from '../runs/run-store-open.testkit.ts';
import { completedWorker, DISCARD } from './destruction-results.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture } from './service.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';

// The worker collect row of the removal cases table (spec 2026-11-21-run-lifecycle-and-store-ports):
// collecting a worker whose history deletion is pending asks the history gate through
// `canDeleteRun`, and a refusal answers as today. The fixture seals the shipped slots; the
// autosave gate refuses while live cleanup evidence names this process.
describe('worker collect during a pending history deletion', { timeout: 15_000 }, () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { onTestFinished(scopeFixtureProcesses()); f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.queries.listRuns()) f.manager.cancel(run.id);
    vi.restoreAllMocks(); await f.close();
  });

  it('refuses with incompatible_state "Worker history deletion evidence is unavailable" while the history gate refuses, and collects once it allows', async () => {
    const { workerId } = await completedWorker(f);
    await f.service.destroy(f.caller, { workerId }, DISCARD);
    const original = runPersistence(f.store).persist;
    const fault = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation((changes, transaction) => {
      if (changes.deletes.includes(workerId)) throw Error('final deletion checkpoint failed');
      return original(changes, transaction);
    });
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    fault.mockRestore();
    const dataDir = join(f.root, '.ai/cezar');
    retainAutosaveCleanup(dataDir, workerId, f.root, 'autosave cleanup pending', { processes: [], groups: [], uncertain: false });

    await expect(f.service.collect(f.caller, { workerId })).rejects.toMatchObject({
      code: 'incompatible_state', message: 'Worker history deletion evidence is unavailable',
    });
    clearAutosaveCleanup(dataDir, workerId);
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ settled: true, diff: { state: 'available' } });
  });
});
