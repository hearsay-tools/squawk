import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../core/runner-registry.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { projectMovedMarker, projectPaths } from '../project-paths.ts';
import { RunDatabase, RUNS_DB_FILE } from '../runs/run-database.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { CockpitOwnership } from './cockpit-ownership.ts';
import { ProjectContexts, type ProjectContextSource } from './project-context.ts';
import { createRunManager } from './run-manager.testkit.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, task: id, workflow: 'quick-task', steps: [], status: RUN_STATUS.done, tokensUsed: 0, archived: false,
  createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const legacyDir = (root: string) => join(root, '.ai', 'cezar');

function writeIndex(dataDir: string, runs: unknown[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(runs));
}

/** A completed project move: `.ai/squawk/` is written, `.ai/cezar/` is the read fallback. */
function markMoved(root: string): void {
  mkdirSync(join(root, '.git'));
  const marker = projectMovedMarker(root)!;
  mkdirSync(dirname(marker.path), { recursive: true });
  writeFileSync(marker.path, JSON.stringify({ version: 1, root: marker.root }));
}

/** What a folder holds, or undefined when it does not exist. A read-only look at a run database
 *  may leave SQLite's `-wal` and `-shm` files; they hold nothing. */
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(name => !/-(wal|shm)$/.test(name)).sort() : undefined);

/** This process's open handles on `path` (Linux). */
function openHandles(path: string): number {
  return readdirSync('/proc/self/fd').filter(fd => {
    try { return readlinkSync(`/proc/self/fd/${fd}`) === path; } catch { return false; }
  }).length;
}

/**
 * Background maintenance (archive and completion ticks) over a project through
 * `withMaintenanceStore`: the live store when the project is open, otherwise a short-lived
 * maintenance store that never recovers a manager, and nothing at all for a project without
 * history, one this cockpit may not touch, or one that is removed meanwhile.
 */
describe('ProjectContexts.withMaintenanceStore', () => {
  let root: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-ctx-maintenance-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[] = [{ id: 'p', root, status: 'not-git' }]): ProjectContexts {
    return new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: async () => projects });
  }

  it.each<[string, (root: string) => void, boolean]>([
    ['no project folder', () => undefined, false],
    ['a project folder without history', root => { mkdirSync(legacyDir(root), { recursive: true }); writeFileSync(join(legacyDir(root), 'config.json'), '{}'); }, false],
    ['a run database whose first import never committed', root => { mkdirSync(legacyDir(root), { recursive: true }); RunDatabase.open(join(legacyDir(root), RUNS_DB_FILE)).close(); }, false],
    ['an imported run database', root => seedRuns(legacyDir(root), [record('kept')]), true],
    ['only runs.json', root => writeIndex(legacyDir(root), [record('kept')]), true],
    ['a moved project whose run database is still in .ai/cezar', root => { markMoved(root); seedRuns(legacyDir(root), [record('kept')]); }, true],
    ['a moved project whose runs.json is still in .ai/cezar', root => { markMoved(root); writeIndex(legacyDir(root), [record('kept')]); }, true],
    ['a moved project whose .ai/cezar holds no history', root => { markMoved(root); mkdirSync(join(legacyDir(root), 'worktrees'), { recursive: true }); }, false],
  ])('over %s: opens a store only where history exists', async (_layout, layout, opens) => {
    layout(root);
    const write = projectPaths(root).write;
    const before = listing(write);
    const contexts = makeContexts();

    const seen = await contexts.withMaintenanceStore('p', async store => ({ title: store.getRun('kept')?.title }));

    expect(seen).toEqual(opens ? { title: 'kept' } : undefined);
    if (!opens) expect(listing(write)).toEqual(before);
    expect(contexts.ids()).toEqual([]);
  });

  it.each<[string, (root: string) => ProjectContextSource[]]>([
    ['an id the registry does not hold', () => []],
    ['a project whose folder is missing', root => [{ id: 'p', root, status: 'missing' }]],
  ])('skips %s and writes nothing', async (_case, projects) => {
    writeIndex(legacyDir(root), [record('kept')]);
    const contexts = makeContexts(projects(root));

    expect(await contexts.withMaintenanceStore('p', async () => 'ran')).toBeUndefined();
    expect(listing(legacyDir(root))).toEqual(['runs.json']);
  });

  it('leaves a project another live cockpit owns alone', async () => {
    writeIndex(legacyDir(root), [record('kept')]);
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    children.push(other);
    const startToken = processStartToken(other.pid!);
    writeFileSync(join(legacyDir(root), 'cockpit.lock'), JSON.stringify({
      pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}), url: 'http://127.0.0.1:1/',
    }));
    const contexts = makeContexts();

    expect(await contexts.withMaintenanceStore('p', async () => 'ran')).toBeUndefined();
    expect(listing(legacyDir(root))).toEqual(['cockpit.lock', 'runs.json']);
  });

  it('tells the operator a legacy folder is in use and keeps the run database out of git', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeIndex(legacyDir(root), [record('kept')]);

    expect(await makeContexts().withMaintenanceStore('p', async store => store.getRun('kept')?.title)).toBe('kept');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Legacy project directory ${legacyDir(root)} is still in use`));
    expect(readFileSync(join(legacyDir(root), '.gitignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining([RUNS_DB_FILE, 'runs.json']));
  });

  it.runIf(process.platform === 'linux')('saves the work, leaves live runs to recovery and keeps no handle on the database', async () => {
    const stopped = record('stopped', { status: RUN_STATUS.running, stopping: true });
    seedRuns(legacyDir(root), [stopped, record('finished')]);
    const database = realpathSync(join(legacyDir(root), RUNS_DB_FILE));

    await makeContexts().withMaintenanceStore('p', async store => {
      store.updateRun('finished', { title: 'renamed by maintenance' });
    });

    const saved = readPersistedRuns(legacyDir(root));
    expect(saved.find(run => run.id === 'finished')?.title).toBe('renamed by maintenance');
    // A Stop accepted before a crash is the next context's recovery to settle, not maintenance's.
    expect(saved.find(run => run.id === 'stopped')).toMatchObject({ status: RUN_STATUS.running, stopping: true });
    expect(openHandles(database)).toBe(0);
  });

  it('runs on the live store of a built project, and the lease ends with the work', async () => {
    const contexts = makeContexts();
    const ctx = await contexts.context('p');
    const task = ctx.store.createRun({ title: 'before', workflow: 'w', task: 't', steps: [] });
    let lease!: () => boolean;

    const result = await contexts.withMaintenanceStore('p', async (store, current) => {
      lease = current;
      store.updateRun(task.id, { title: 'archived by maintenance' });
      return current();
    });

    expect(result).toBe(true);
    expect(ctx.store.getRun(task.id)?.title).toBe('archived by maintenance');
    expect(lease()).toBe(false);
    await contexts.disposeAll();
  });

  it('refuses a second lease while one runs, and any lease while the project is being built', async () => {
    seedRuns(legacyDir(root), [record('kept')]);
    const contexts = makeContexts();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = contexts.withMaintenanceStore('p', async () => { entered(); await gate; return 'first'; });
    await started;

    const second = contexts.withMaintenanceStore('p', async () => 'second');
    release();
    expect(await second).toBeUndefined();
    expect(await first).toBe('first');

    const building = contexts.context('p');
    expect(await contexts.withMaintenanceStore('p', async () => 'during build')).toBeUndefined();
    await building;
    await contexts.disposeAll();
  });

  it.each(['dispose', 'disposeAll'] as const)('a cold lease turns stale on %s, and ends with its work', async (removal) => {
    seedRuns(legacyDir(root), []);
    const contexts = makeContexts();
    let lease!: () => boolean;
    await contexts.withMaintenanceStore('p', async (_store, current) => {
      lease = current;
      expect(current()).toBe(true);
      if (removal === 'dispose') contexts.dispose('p');
      else void contexts.disposeAll();
      expect(current()).toBe(false);
    });
    expect(lease()).toBe(false);

    const ended = makeContexts();
    await ended.withMaintenanceStore('p', async (_store, current) => { lease = current; });
    expect(lease()).toBe(false);
  });

  it('drops a lease whose project is removed while it waits for the project claim', async () => {
    writeIndex(legacyDir(root), [record('kept')]);
    // Another claim in this process holds the project: the lease retries until it is released.
    const other = new CockpitOwnership();
    await other.acquire(legacyDir(root));
    const contexts = makeContexts();
    const claim = CockpitOwnership.prototype.acquire;
    let claiming!: () => void;
    const atClaim = new Promise<void>(resolve => { claiming = resolve; });
    vi.spyOn(CockpitOwnership.prototype, 'acquire').mockImplementation(function (this: CockpitOwnership, dataDir: string) {
      claiming();
      return claim.call(this, dataDir);
    });

    const lease = contexts.withMaintenanceStore('p', async () => 'ran');
    // The lease's claim has started; its first attempt found the other claim and now retries.
    await atClaim;
    contexts.dispose('p');
    other.releaseAll();

    expect(await lease).toBeUndefined();
    expect(existsSync(join(legacyDir(root), RUNS_DB_FILE))).toBe(false);
  });
});
