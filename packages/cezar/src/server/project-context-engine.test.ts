import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { projectPaths } from '../project-paths.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitUsageForTest } from '../core/process-usage.ts';
import { ProjectContexts, type ProjectContextSource } from './project-context.ts';
import { createRunManager } from './engine-run-manager.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { createRunner } from '../core/runner-registry.ts';
registerRunner(claudeRunner);


const observed = vi.hoisted(() => ({
  subscriptions: [] as Array<{ listener: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../core/process-usage.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/process-usage.ts')>();
  return { ...actual, onUsage: (listener: Parameters<typeof actual.onUsage>[0]) => {
    const observedListener = vi.fn(listener);
    const unsubscribe = vi.fn(actual.onUsage(observedListener));
    observed.subscriptions.push({ listener: observedListener, unsubscribe });
    return unsubscribe;
  } };
});

/**
 * The cases of `project-context.test.ts` that need the real run engine: RunManager's constructor
 * subscribes to the usage sampler, and a disposed context's manager stops receiving its ticks.
 */
describe('ProjectContexts (run engine)', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    observed.subscriptions.length = 0;
    rootA = mkdtempSync(join(tmpdir(), 'cez-ctx-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'cez-ctx-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[]): ProjectContexts {
    return new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: async () => projects });
  }

  it('dispose(): the manager receives no further usage ticks and the store is flushed and closed', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const ctx = await contexts.context('a');
    const run = ctx.store.createRun({ title: 'pending', workflow: 'w', task: 't', steps: [] });
    const { listener: spy, unsubscribe } = observed.subscriptions.at(-1)!;

    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1);

    expect(contexts.dispose('a')).toBe(true);
    emitUsageForTest({});
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed — no further ticks
    // Store closed: the pending row landed on disk despite the debounced save, and a late write
    // to the disposed store saves nothing.
    expect(readPersistedRuns(projectPaths(rootA).write).map((saved) => saved.id)).toEqual([run.id]);
    ctx.store.updateRun(run.id, { title: 'after dispose' });
    ctx.store.flush();
    expect(readPersistedRuns(projectPaths(rootA).write)[0]?.title).toBe('pending');
    expect(ctx.store.eventNames()).toEqual([]);

    // Disposed id is gone from the map; the next access builds a fresh context.
    expect(contexts.peek('a')).toBeUndefined();
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    contexts.dispose('a');
  });

  it('disposeAll() tears down every built context', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    await contexts.context('a');
    await contexts.context('b');
    const [subscriptionA, subscriptionB] = observed.subscriptions.slice(-2);

    contexts.disposeAll();
    expect(contexts.ids()).toEqual([]);
    emitUsageForTest({});
    expect(subscriptionA!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionB!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionA!.listener).not.toHaveBeenCalled();
    expect(subscriptionB!.listener).not.toHaveBeenCalled();
  });
});
