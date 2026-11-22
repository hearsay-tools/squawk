import '../core/register-all-runners.testkit.ts';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunEvent, type RunRecord } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { createRunManager } from './engine-run-manager.testkit.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

/**
 * The case of `task-webhook-api.test.ts` that needs the real run engine: recovery of a lazily built
 * project moves a seeded running row, and the task webhook reports that move.
 */
describe('task webhook API (run engine)', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let projectId: string;
  let started: StartRunInput[];
  let posted: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  const fakeFetch = (async (url: string, init: RequestInit) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-repo-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    projectId = (await registerProject(repoRoot, undefined, testHome())).id;
    started = [];
    posted = [];
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, env] of [['home', 'CEZ_HOME'], ['dryRun', 'CEZ_DRY_RUN']] as const) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  });

  const manager = {
    startRun: (_workflow: unknown, input: StartRunInput) => {
      started.push(input);
      return store.createRun({ title: input.task, workflow: 'quick-task', task: input.task, notify: input.notify, steps: [] });
    },
  } as unknown as RunManager;

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ home: testHome(), repoRoot, store, manager, version: '0.0.0-test', bootProjectId: projectId, taskWebhookFetch: fakeFetch, ...over });

  describe('recovery (#589 review)', () => {
    it('reports the transitions a lazily built project makes while recovering', async () => {
      const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-other-'))
      try {
        // A run that was live when the last process exited: recovery moves it on, and that move
        // is exactly what an opted-in bot is waiting for.
        mkdirSync(join(other, '.ai/cezar'), { recursive: true });
        seedRuns(join(other, '.ai/cezar'), [{
          id: 'live', title: 'live', task: 'live', workflow: 'quick-task', status: RUN_STATUS.running, notify: true,
          createdAt: '2026-09-25T10:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
        }]);
        const entry = await registerProject(other, undefined, testHome());
        await mergeWriteWorkspaceConfig((config) => {
          config.projects.find((p) => p.id === entry.id)!.webhook = { url: 'https://bot.example/hook', token: 't' };
        }, testHome());
        const app = makeApp({ createManager: createRunManager, semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
        const res = await apiRequest(app, `/api/v1/p/${entry.id}/runs/live`);
        const after = (await res.json()) as RunRecord;
        expect(after.status).not.toBe('running');
        await vi.waitFor(() => {
          const reader = RunStore.open(join(other, '.ai/cezar'));
          let events: RunEvent[];
          try { events = reader.eventLog.readEvents('live'); } finally { reader.close(); }
          expect(events.find((event) => event.type === 'webhook.dry-run')).toMatchObject({
            event: 'task.status',
            payload: { previousStatus: 'running', status: after.status },
          });
        }, { timeout: HANG_GUARD_MS });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});
