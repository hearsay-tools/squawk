import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectMoveMarked, projectPaths } from '../project-paths.ts';
import { CockpitOwnership, projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { moveProjectWhenIdle } from './auto.ts';
import { DatabaseSync } from 'node:sqlite';
import { LEGACY_RUNS_FILE } from '../legacy-runs.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { crashAt } from './engine.testkit.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';

/**
 * A legacy directory that holds nothing to move (empty, or only tracked files) and no
 * `.ai/squawk/`: the migration has no move and no kept task, so it must not need the new
 * directory to exist, neither on its first run nor on a recovery.
 */

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.releaseAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(tracked: boolean): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-empty-source-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  if (tracked) {
    mkdirSync(join(root, '.ai/cezar/workflows'));
    writeFileSync(join(root, '.ai/cezar/workflows/flow.yaml'), 'name: flow\n');
    git('add', '.ai/cezar');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'flow');
  }
  return root;
}

async function fence(root: string) {
  const ownership = new CockpitOwnership();
  owners.push(ownership);
  return ownership.fenceProject(join(root, '.ai/cezar'), { liveTasks: () => [] });
}

describe('a project move with nothing to move and no .ai/squawk/', () => {
  for (const tracked of [false, true]) {
    it(`finishes with ${tracked ? 'only tracked files' : 'an empty .ai/cezar/'}`, async () => {
      const root = project(tracked);
      const held = await fence(root);
      const result = await migrateProject({ repoRoot: root, fence: held });
      owners.splice(0).forEach(owner => owner.releaseAll());
      expect(result.journal.moves).toEqual([]);
      expect(result.journal.leftovers).toEqual([]);
      expect(projectMoveMarked(root)).toBe(true);
      expect(existsSync(join(root, '.ai/squawk-migration.json'))).toBe(false);
      expect(projectAdmissionRefusal(join(root, '.ai/cezar'))).toBeUndefined();
    });
  }

  for (const tracked of [false, true]) {
    it(`moves and marks it at cockpit start with ${tracked ? 'only tracked files, and names their git mv' : 'an empty .ai/cezar/'}`, async () => {
      const root = project(tracked);
      const lines: string[] = [];
      const result = await moveProjectWhenIdle(root, { homes: [], log: line => lines.push(line) });
      const gitMv = tracked
        ? [`cd -- '${root}'`, "mkdir -p -- '.ai/squawk/workflows'", "git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'"] : [];
      expect(result).toEqual({ status: 'moved', gitMv, leftovers: [] });
      expect(projectMoveMarked(root)).toBe(true);
      expect(existsSync(join(root, '.ai/squawk-migration.json'))).toBe(false);
      expect(projectAdmissionRefusal(join(root, '.ai/cezar'))).toBeUndefined();
      // One command per line, so the operator can paste them into a shell; no command list without tracked files.
      expect(lines).toEqual([`[hsq] Moved the state of ${root} from .ai/cezar/ to .ai/squawk/.${tracked
        ? ` Tracked files stay; run these and commit:\n${gitMv.map(line => `  ${line}`).join('\n')}` : ''}`]);
      // The move took a claim of its own and released it: a cockpit can serve the project now.
      const cockpit = new CockpitOwnership();
      owners.push(cockpit);
      await cockpit.acquire(projectPaths(root).write);
      expect(cockpit.owns(join(root, '.ai/squawk'))).toBe(true);
      expect(await moveProjectWhenIdle(root, { homes: [], log: line => lines.push(line) })).toEqual({ status: 'nothing' });
    });
  }

  it('repairs an unreadable kept-task list of the moved project at the next start', async () => {
    const root = project(false);
    expect(await moveProjectWhenIdle(root, { homes: [], log: () => undefined })).toMatchObject({ status: 'moved' });
    const list = join(root, '.ai/squawk', LEGACY_RUNS_FILE);
    mkdirSync(join(root, '.ai/squawk'), { recursive: true });
    writeFileSync(list, 'not json');
    // Nothing is left in .ai/cezar/, but the move rewrites the list from the run store: no task keeps files there.
    expect(await moveProjectWhenIdle(root, { homes: [], log: () => undefined })).toEqual({ status: 'moved', gitMv: [], leftovers: [] });
    expect(existsSync(list)).toBe(false);
    expect(await moveProjectWhenIdle(root, { homes: [], log: () => undefined })).toEqual({ status: 'nothing' });
  });

  it('does not plan a moved project again while a task record in it cannot be read', async () => {
    const root = project(false);
    expect(await moveProjectWhenIdle(root, { homes: [], log: () => undefined })).toMatchObject({ status: 'moved' });
    const store = RunStore.open(join(root, '.ai/squawk'), { keepLive: true });
    let id: string;
    try { id = store.createRun({ title: 'later', task: 'later', workflow: 'quick-task', steps: [] }).id; store.flush(); } finally { store.close(); }
    // A record a newer build wrote, which this build cannot read.
    const database = new DatabaseSync(join(root, '.ai/squawk', RUNS_DB_FILE));
    try { database.prepare('UPDATE runs SET data = ?, archived = 0 WHERE id = ?').run('{"unknown":true}', id); } finally { database.close(); }
    const lines: string[] = [];
    expect(await moveProjectWhenIdle(root, { homes: [], log: line => lines.push(line) })).toEqual({ status: 'nothing' });
    expect(lines).toEqual([]);
  });

  it('a recovery of its interrupted journal finishes too', async () => {
    const root = project(true);
    const crashed = await fence(root);
    await expect(migrateProject({ repoRoot: root, fence: crashed, fault: crashAt('journal:written') })).rejects.toThrow('journal:written');
    owners.splice(0).forEach(owner => owner.releaseAll());
    expect(projectAdmissionRefusal(join(root, '.ai/cezar'))?.reason).toBe('journal');
    const recovery = await fence(root);
    const resumed = await resumeProjectMigration({ repoRoot: root, fence: recovery });
    expect(resumed?.resumed).toBe(true);
    expect(projectMoveMarked(root)).toBe(true);
    expect(existsSync(join(root, '.ai/squawk-migration.json'))).toBe(false);
  });
});
