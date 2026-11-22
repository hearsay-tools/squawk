import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeWorktreesRepo, seedWorktreeRun, worktreesRepo } from '../server/worktrees-api.testkit.ts';
import { provisionArtifactDirectory } from '../artifacts/lifecycle.ts';
import { reclaimWorktree } from './retention.ts';
import { runSlotsSealed } from './removal-slots.ts';
import { setRunStatus, seedRuns } from './run-store.testkit.ts';
import { RunStore } from './store.ts';
import { sweepAgentTmpDirs } from './agent-tmpdir.ts';
import { RunSettlement } from '../workflows/run/run-settlement.ts';
import { unused } from '../workflows/unused.testkit.ts';

// This file seals no removal slot, as a process entry that forgot registerBuiltInRunSlots() would
// not: each removal throws before its first side effect (spec 2026-11-21-run-lifecycle-and-store-ports,
// "Removal cases", last row). The worker family end case is in `delegation/family-end-unsealed.test.ts`.
const UNSEALED = /No removal slot is registered: call registerBuiltInRunSlots\(\)/;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

it('starts unsealed', () => {
  expect(runSlotsSealed()).toBe(false);
});

it('a deletion throws and removes no row, history, artifact or tmp directory', () => {
  const dataDir = join(scratch('cez-unsealed-delete-'), '.ai/cezar');
  const store = RunStore.open(dataDir);
  const run = store.createRun({ title: 'kept', task: 'kept', workflow: 'quick-task', steps: [] });
  store.eventLog.appendEvent(run.id, { type: 'note', message: 'kept history' });
  setRunStatus(store, run.id, RUN_STATUS.done);
  const artifacts = provisionArtifactDirectory(dataDir, run.id);
  writeFileSync(join(artifacts, 'snapshot'), 'kept');
  const tmp = join(dataDir, 'tmp', run.id);
  mkdirSync(tmp, { recursive: true });
  store.persistence.flush();

  expect(() => store.retention.deleteRun(run.id)).toThrow(UNSEALED);
  store.persistence.flush();
  store.close();

  const reopened = RunStore.open(dataDir);
  expect(reopened.getRun(run.id)?.status).toBe(RUN_STATUS.done);
  expect(reopened.eventLog.readEvents(run.id).map(event => event.type)).toContain('note');
  expect([existsSync(join(artifacts, 'snapshot')), existsSync(tmp)]).toEqual([true, true]);
  reopened.close();
});

it('a reclaim throws and keeps the worktree and the run unstamped', async () => {
  const savedHome = process.env.CEZ_HOME;
  const paths = await worktreesRepo();
  cleanups.push(() => removeWorktreesRepo(paths, savedHome));
  const store = RunStore.open(join(paths.repoRoot, '.ai/cezar'));
  cleanups.unshift(() => store.close());
  const id = await seedWorktreeRun(paths.repoRoot, store, randomUUID(), 'done', '2026-01-01T00:00:00.000Z');
  const run = store.getRun(id)!;

  await expect(reclaimWorktree(paths.repoRoot, store, run)).rejects.toThrow(UNSEALED);
  expect(existsSync(run.worktreePath!)).toBe(true);
  expect(store.getRun(id)?.worktreeReclaimedAt).toBeUndefined();
});

it('a family archive throws and keeps the family unarchived with its tmp directory', () => {
  const dataDir = scratch('cez-unsealed-archive-');
  const old = { id: 'old-done', title: 'old', workflow: 'quick-task', task: 'old', status: RUN_STATUS.done,
    createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] };
  seedRuns(dataDir, [old, ...Array.from({ length: 300 }, (_, index) => ({ ...old, id: `newer-${index}`, createdAt: '2026-02-01T00:00:00.000Z' }))]);
  const tmp = join(dataDir, 'tmp', old.id);
  mkdirSync(tmp, { recursive: true });
  const store = RunStore.open(dataDir, { keepLive: true });

  expect(() => store.createRun({ title: 'trigger retention', workflow: 'w', task: 'task', steps: [] })).toThrow(UNSEALED);
  expect(store.getRun(old.id)?.archived).toBe(false);
  expect(existsSync(tmp)).toBe(true);
  store.close();
});

it('a terminal scratch reap throws before it reads anything and keeps the tmp directory', () => {
  const dataDir = join(scratch('cez-unsealed-reap-'), '.ai/cezar');
  const tmp = join(dataDir, 'tmp', 'ended-run');
  mkdirSync(tmp, { recursive: true });
  type Args = ConstructorParameters<typeof RunSettlement>;
  // Every collaborator throws on its first use, so only the seal check can name the registration.
  const settlement = new RunSettlement(unused<Args[0]>('context'), unused<Args[1]>('humanWaits'), unused<Args[2]>('workerQuestions'),
    unused<Args[3]>('autosave'), unused<Args[4]>('line'), unused<Args[5]>('resume'), unused<Args[6]>('workers'),
    unused<Args[7]>('completionGate'), unused<Args[8]>('host'), '', '');

  expect(() => settlement.reapTerminalScratch('ended-run')).toThrow(UNSEALED);
  expect(existsSync(tmp)).toBe(true);
});

it('the startup orphan sweep throws and keeps the orphan tmp directory', () => {
  const dataDir = join(scratch('cez-unsealed-sweep-'), '.ai/cezar');
  const orphan = join(dataDir, 'tmp', randomUUID());
  mkdirSync(orphan, { recursive: true });

  expect(() => sweepAgentTmpDirs(dataDir, [])).toThrow(UNSEALED);
  expect(existsSync(orphan)).toBe(true);
});
