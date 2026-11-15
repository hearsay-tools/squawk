import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunner } from '../core/runner-factory.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { CockpitOwnership } from './cockpit-ownership.ts';
import { ProjectContexts, ProjectContextsClosedError, type ProjectContextDeps } from './project-context.ts';
import { createRunManager } from './run-manager.testkit.ts';

/** Lets a test hold a build inside its migration step; open when `gate` is unset. */
const preparing = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, entered: () => {} }));
vi.mock('../project-migration/auto.ts', async (original) => {
  const real = await original<typeof import('../project-migration/auto.ts')>();
  return { ...real, prepareProject: async (...args: Parameters<typeof real.prepareProject>) => {
    preparing.entered();
    await preparing.gate;
    return real.prepareProject(...args);
  } };
});

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

/** A gate a test opens, and a signal the product reaches. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * Project removal runs `dispose(id)` after the registry commit, and a build of that project may be
 * anywhere between reading the registry and recovering its runs (hearsay-tools/cezarion#667).
 * Whatever step it is in, the removed project gets no context, no store left open, no claim and no
 * moved files.
 */
describe('a project build that removal or a failure overtakes', () => {
  const roots: string[] = [];

  afterEach(() => {
    preparing.gate = undefined;
    preparing.entered = () => {};
    vi.restoreAllMocks();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-ctx-race-'));
    roots.push(dir);
    return dir;
  }

  function makeContexts(projectRoot: string, deps: Partial<ProjectContextDeps> = {}): ProjectContexts {
    return new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(),
      listProjects: async () => [{ id: 'p', root: projectRoot, status: 'ok' }], ...deps });
  }

  /** How many stores the contexts opened, and how many of them are closed. */
  function watchStores(contexts: ProjectContexts): { opened: number; closed: number } {
    const counts = { opened: 0, closed: 0 };
    contexts.onStoreCreated((store) => {
      counts.opened += 1;
      store.once('closed', () => { counts.closed += 1; });
    });
    return counts;
  }

  it('never moves the files of a project removed while its build read the registry', async () => {
    const project = root();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-qm', 'base', '--allow-empty'], { cwd: project });
    seedRuns(join(project, '.ai/cezar'), [{ id: 'kept', title: 'kept', task: 'kept', workflow: 'quick-task', steps: [], status: RUN_STATUS.done, tokensUsed: 0, archived: false, createdAt: '2026-01-01T00:00:00.000Z' }]);
    const reading = latch(), registry = latch();
    const contexts = makeContexts(project, {
      listProjects: async () => { reading.open(); await registry.promise; return [{ id: 'p', root: project, status: 'ok' }]; },
    });

    const building = contexts.context('p');
    await reading.promise;
    contexts.dispose('p');
    registry.open();

    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(readdirSync(join(project, '.ai'))).toEqual(['cezar']);
    expect(readdirSync(join(project, '.ai/cezar'))).toContain('runs.db');
  });

  it('never claims or creates the data folder of a project removed while its build prepared it', async () => {
    const project = root();
    const ownership = new CockpitOwnership();
    const migrating = latch(), migration = latch();
    preparing.entered = migrating.open;
    preparing.gate = migration.promise;
    const contexts = makeContexts(project, { ownership });

    try {
      const building = contexts.context('p');
      await migrating.promise;
      contexts.dispose('p');
      migration.open();

      await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
      expect(existsSync(join(project, '.ai'))).toBe(false);
    } finally {
      ownership.releaseAll();
    }
  });

  it('closes the store of a project removed while its build recovered, and registers nothing', async () => {
    const recovering = latch();
    const recover = vi.spyOn(RunManager.prototype, 'recover').mockImplementation(() => recovering.promise);
    const contexts = makeContexts(root());
    const stores = watchStores(contexts);

    const building = contexts.context('p');
    await vi.waitFor(() => expect(recover).toHaveBeenCalled(), { timeout: HANG_GUARD_MS });
    expect(contexts.dispose('p')).toBe(false);
    recovering.open();

    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(contexts.peek('p')).toBeUndefined();
    expect(stores).toEqual({ opened: 1, closed: 1 });
  });

  it.each([
    ['with session setup', true],
    ['without session setup', false],
  ])('a build whose recovery fails closes its store, undoes its setup and builds again on the next access (%s)', async (_case, withSetup) => {
    const failure = new Error('recovery failed');
    vi.spyOn(RunManager.prototype, 'recover').mockRejectedValueOnce(failure);
    const released: string[] = [];
    const contexts = makeContexts(root(), withSetup ? { prepareManager: (project) => () => { released.push(project.id); } } : {});
    const stores = watchStores(contexts);

    await expect(contexts.context('p')).rejects.toBe(failure);
    expect(released).toEqual(withSetup ? ['p'] : []);
    expect(stores).toEqual({ opened: 1, closed: 1 });
    expect(contexts.peek('p')).toBeUndefined();

    expect((await contexts.context('p')).id).toBe('p');
    expect(stores).toEqual({ opened: 2, closed: 1 });
    await contexts.disposeAll();
  });
});
