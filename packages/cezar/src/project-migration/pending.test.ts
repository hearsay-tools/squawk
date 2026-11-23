import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedWorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { LEGACY_RUNS_FILE } from '../legacy-runs.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { moveProjectWhenIdle } from './auto.ts';
import { fence, TIMEOUT } from './engine.testkit.ts';
import { migrateProject } from './engine.ts';
import { keptAmong, projectKeptRunIds } from './live.ts';
import { legacyMoveWorkLeft } from './pending.ts';
import { planProjectMigration } from './plan.ts';
import { buildMigrationProject, removeMigrationProject, TASK, WORKER, type MigrationProject } from './project-migration.testkit.ts';

/**
 * The cockpit's check before it plans a moved project (`pending.ts`): a moved project whose
 * `.ai/cezar/` holds only ownership claims, tracked files and the items of tasks that can still
 * resume is not planned at each start; anything else is. A move plans once when no other writer
 * is live.
 */

vi.mock('./plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan.ts')>();
  return { ...actual, planProjectMigration: vi.fn(actual.planProjectMigration) };
});

async function checkpoint(root: string, workspace: OwnedWorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

function changeRun(dataDir: string, change: (store: RunStore) => void): void {
  const store = RunStore.open(dataDir, { keepLive: true });
  try { change(store); store.persistence.flush(); } finally { store.close(); }
}

describe('the check before a moved project is planned', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  /** The project moved with WORKER done but not archived: its worktree stays in `.ai/cezar/`. */
  async function movedKeepingWorker(): Promise<void> {
    project.restore();
    changeRun(project.dataDir, store => store.archive.setArchived(WORKER, false));
    const held = await fence(project);
    try { expect((await migrateProject({ repoRoot: project.root, fence: held })).journal.leftovers).toEqual([WORKER]); }
    finally { held.release(); }
  }

  beforeEach(() => { vi.mocked(planProjectMigration).mockClear(); });

  it('finds nothing while the only items left are tracked files, ownership claims and a kept task\'s, and does not plan', async () => {
    await movedKeepingWorker();
    writeFileSync(join(project.dataDir, 'cockpit.lock'), '{}');
    expect(await legacyMoveWorkLeft(project.root)).toBe(false);
    vi.mocked(planProjectMigration).mockClear();
    expect(await moveProjectWhenIdle(project.root, { homes: [], log: () => undefined })).toEqual({ status: 'nothing' });
    expect(planProjectMigration).not.toHaveBeenCalled();
  });

  it('finds work once the kept task is archived, and the move carries its items', async () => {
    await movedKeepingWorker();
    changeRun(project.newDir, store => store.archive.setArchived(WORKER, true));
    expect(await legacyMoveWorkLeft(project.root)).toBe(true);
    vi.mocked(planProjectMigration).mockClear();
    const result = await moveProjectWhenIdle(project.root, { homes: [], log: () => undefined });
    expect(result).toEqual({ status: 'moved', gitMv: expect.any(Array), leftovers: [] });
    expect(planProjectMigration).toHaveBeenCalledTimes(1);
    expect(await legacyMoveWorkLeft(project.root)).toBe(false);
  });

  it('finds work for an untracked item no kept task owns, and for an unreadable kept-task list', async () => {
    await movedKeepingWorker();
    writeFileSync(join(project.dataDir, 'stray.txt'), 'left by an older binary');
    expect(await legacyMoveWorkLeft(project.root)).toBe(true);
    await movedKeepingWorker();
    writeFileSync(join(project.newDir, LEGACY_RUNS_FILE), 'not json');
    expect(await legacyMoveWorkLeft(project.root)).toBe(true);
  });

  it('finds work when Git skips a directory it cannot open, since the listing may be incomplete', async () => {
    await movedKeepingWorker();
    // A kept task's scratch directory: Git warns, skips it and still exits 0.
    const locked = join(project.dataDir, 'tmp', WORKER);
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'scratch.txt'), 'x');
    expect(await legacyMoveWorkLeft(project.root)).toBe(false);
    chmodSync(locked, 0o000);
    try { expect(await legacyMoveWorkLeft(project.root)).toBe(true); } finally { chmodSync(locked, 0o700); }
  });

  it('says why a moved project\'s leftover items did not move', async () => {
    await movedKeepingWorker();
    writeFileSync(join(project.dataDir, 'stray.json'), '{}');
    writeFileSync(join(project.newDir, 'stray.json'), '{}');
    const lines: string[] = [];
    const reason = `${join(project.newDir, 'stray.json')}: ${join(project.dataDir, 'stray.json')} would replace an existing path`;
    expect(await moveProjectWhenIdle(project.root, { homes: [], log: line => lines.push(line) })).toEqual({ status: 'blocked', reason });
    expect(lines).toEqual([`[hsq] Project ${project.root} keeps items in .ai/cezar/ that did not move: ${reason}. `
      + 'They stay readable there; the move runs again at the next start.']);
  });

  it('judges each task as the full kept-task read does', async () => {
    await movedKeepingWorker();
    const ids = new Set([WORKER, TASK, 'deleted-task']);
    const agree = () => expect(keptAmong(project.root, ids)).toEqual(new Set([...ids].filter(id => projectKeptRunIds(project.root).has(id))));
    agree();
    // A live task, archived or not, and a finished one, archived or not.
    changeRun(project.newDir, store => setRunStatus(store, TASK, 'waiting', { archived: true }));
    agree();
    expect(keptAmong(project.root, ids)).toEqual(new Set([WORKER, TASK]));
    changeRun(project.newDir, store => { setRunStatus(store, TASK, 'done', { archived: true }); store.archive.setArchived(WORKER, true); });
    agree();
    expect(keptAmong(project.root, ids)).toEqual(new Set());
  });

  it('plans a move once when no other writer is live', async () => {
    project.restore();
    const result = await moveProjectWhenIdle(project.root, { homes: [], log: () => undefined });
    expect(result.status).toBe('moved');
    expect(planProjectMigration).toHaveBeenCalledTimes(1);
  });
});
