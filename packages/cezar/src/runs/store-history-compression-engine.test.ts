import { fakeRunnerFactory } from '../core/fake-runner-factory.testkit.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from './run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { historyPaths } from './history-file.ts';
import { RunStore } from './store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-manager.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import type { RunManager } from '../workflows/run.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const captured = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  release: undefined as (() => void) | undefined,
}));
useRunners(fakeRunnerFactory(() => ({
    backend: 'claude',
    interrupt: async () => {},
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: new Promise((resolve) => {
          captured.release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        }),
        sendMessage: () => true,
        discardQueuedMessages: () => {},
        end: () => {},
        interrupt: () => {},
        open: true,
      };
    },
  })));

const stores: RunStore[] = [];
const roots: string[] = [];
const managers: RunManager[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  captured.release?.();
  captured.release = undefined;
  captured.specs.length = 0;
  for (const root of roots) await drainFixtureManagers(root);
  managers.length = 0;
  while (stores.length > 0) {
    const store = stores.pop()!;
    store.close();
    await store.historyIdle();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RunStore history compression', () => {
  it('continue on an archived run appends after the old events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-history-continue-'));
    roots.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const manager = createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
    managers.push(manager);
    const run = store.createRun({
      title: 'task', task: 'task', workflow: 'original', worktree: false,
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateStep(run.id, 'work', { status: STEP_STATUS.done, sessionId: 'old-session' });
    const first = store.appendEvent(run.id, { type: 'note', message: 'before' });
    setRunStatus(store, run.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { plain, compressed } = historyPaths(join(root, '.ai/cezar'), run.id);
    expect(existsSync(compressed)).toBe(true);

    expect(manager.continueRun(run.id, { text: 'keep going' })).toEqual({ ok: true });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);

    await vi.waitFor(() => {
      const seqs = store.readEvents(run.id).map((event) => event.seq).filter((seq): seq is number => typeof seq === 'number');
      expect(Math.max(0, ...seqs)).toBeGreaterThan(first.seq);
    }, { timeout: HANG_GUARD_MS });
    const events = store.readEvents(run.id);
    expect(events).toContainEqual(expect.objectContaining({ seq: first.seq, type: 'note', message: 'before' }));
    const seqs = events.map((event) => event.seq).filter((seq): seq is number => typeof seq === 'number');
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
  });
});
