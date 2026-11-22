import '../core/created-runners.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-manager.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { memoryWorkspaceConfig, providerAuth } from './provider-action-gating.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);

/** Provider gate cases that need a real RunManager: a replay through the engine and a queued run's later step. */
describe('provider action gating', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_AGENT_MODELS_LOCKED;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-action-gating-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it.each([false, true])('preserves inherited account affinity through a real replay (switch provider: %s)', async (switchProvider) => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultRunner: 'codex' }));
    const manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
    try {
      app = createApp({ home: testHome(), repoRoot, store, manager, version: 'test', providerAuth: providerAuth(),
        workspaceConfig: memoryWorkspaceConfig([]),
      });
      const run = store.createRun({ title: 'Untouched', task: 'Task', workflow: 'original', agentProfile: 'saved-codex-account',
        workflowDef: { name: 'original', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] },
        steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }],
      });
      setRunStatus(store, run.id, RUN_STATUS.cancelled);
      const response = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(switchProvider ? { runner: 'claude' } : {}),
      });
      expect(response.status).toBe(200);
      expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.queued, runner: switchProvider ? 'claude' : 'codex' });
      expect(store.getRun(run.id)?.agentProfile).toBe(switchProvider ? undefined : 'saved-codex-account');
    } finally { manager.dispose(); }
  });
});

describe('provider availability preserves existing execution', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    // Resolved from this file, not the cwd: the fixture is a sibling of the source under test,
    // so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(
      import.meta.dirname,
      '../runners/codex/__fixtures__/mock-codex-app-server.mjs',
    );
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-continuity-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 1, memoryLimitMb: 0 }) });
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedCodexBin;
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('run did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('dequeues a task created before disable and reaches its later provider step', async () => {
    const workspaceConfig = memoryWorkspaceConfig([]);
    const app = createApp({ home: testHome(),
      repoRoot,
      store,
      manager,
      version: 'test',
      providerAuth: providerAuth(),
      workspaceConfig,
    });
    const workflow: WorkflowDef = {
      name: 'mixed-existing',
      source: 'built-in',
      steps: [
        // The earlier step signals done, which it needs to advance (hearsay-tools/cezarion#1620).
        { id: 'claude', name: 'Claude', prompt: '{{task}} mock:cezar-done', runner: 'claude' },
        { id: 'codex', name: 'Codex', prompt: '{{task}}', runner: 'codex' },
      ],
    };

    const admissionReads = vi.spyOn(semaphore, 'maxParallel');
    const run = manager.startRun(workflow, {
      task: 'mock:native-codex-ask choose a library',
      runner: 'claude',
      worktree: false,
    });
    runId = run.id;
    expect(store.getRun(run.id)?.status).toBe('queued');

    const disabled = await apiRequest(app, '/api/v1/providers/codex/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    // bound: admission awaits repository discovery before reading capacity.
    await vi.waitFor(() => expect(admissionReads).toHaveBeenCalled(), { timeout: 10_000 });
    expect(semaphore.busy()).toBe(0);
    await semaphore.refresh();
    await semaphore.release();

    await waitFor(() => {
      const current = store.getRun(run.id);
      return current?.currentStepId === 'codex' && current.steps.find((step) => step.id === 'codex')?.status === 'waiting';
    });

    const current = store.getRun(run.id);
    expect(current?.steps.map((step) => ({ id: step.id, status: step.status, backend: step.backend }))).toEqual([
      { id: 'claude', status: STEP_STATUS.done, backend: 'claude' },
      { id: 'codex', status: STEP_STATUS.waiting, backend: 'codex' },
    ]);
  }, 30_000);
});
