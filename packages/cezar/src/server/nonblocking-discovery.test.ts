import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BackendCheck } from '../core/backend-detect.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { createApp, WorkspaceEventBus, type ServerDeps } from './server.ts';
import { BACKEND_MAX_AGE_MS } from './backend-checks.ts';

import * as git from './git.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
registerRunner(claudeRunner);

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const detectEnvironment = vi.fn<() => Promise<BackendCheck[]>>();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function build(modelCatalog = new RunnerModelCatalog({ adapters: {} }), extra: Partial<ServerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-nonblocking-')); roots.push(root);
  return createApp({ home: testHome(), repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', modelCatalog, detectEnvironment, ...extra });
}

// hearsay-tools/cezarion#974: the full Node 24.15 run took 1734ms against 1500ms.
// This cell also builds the app and reads real Git/workspace metadata; its deadline
// is a liveness bound, not a health latency benchmark. The never-resolving probe
// still makes awaiting availability fail within the ordinary 5s unit-test budget.
it('answers cold health while availability probes remain unresolved', async () => {
  vi.mocked(detectEnvironment).mockReturnValue(new Promise(() => {}));
  const app = build();
  const response = await apiRequest(app, '/api/v1/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ checks: [] });
  expect(detectEnvironment).toHaveBeenCalledOnce();
}, 5_000);

it.each([false, true])('keeps last-known availability while an aged probe is pending, dedupes, and retries after failure (held refresh=%s)', async (heldRefresh) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const checks: BackendCheck[] = [{ name: 'omp', available: true, version: '1' }];
    let fail!: (error: Error) => void;
    vi.mocked(detectEnvironment).mockReset().mockResolvedValueOnce(checks)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce([{ name: 'omp', available: false }]);
    const getRepoInfo = git.getRepoInfo;
    let refreshEntered!: () => void;
    const refreshEnteredPromise = new Promise<void>((resolve) => { refreshEntered = resolve; });
    let releaseRefresh!: () => void;
    const releaseRefreshPromise = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshFinished!: () => void;
    const refreshFinishedPromise = new Promise<void>((resolve) => { refreshFinished = resolve; });
    if (heldRefresh) {
      vi.spyOn(git, 'getRepoInfo').mockImplementationOnce(getRepoInfo).mockImplementationOnce(async (...args) => {
        refreshEntered();
        await releaseRefreshPromise;
        try { return await getRepoInfo(...args); }
        finally { refreshFinished(); }
      });
    }
    const app = build();
    await apiRequest(app, '/api/v1/health');
    if (heldRefresh) await refreshEnteredPromise;
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
    vi.setSystemTime(Date.now() + BACKEND_MAX_AGE_MS);
    for (let i = 0; i < 2; i++) {
      expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
      if (heldRefresh && i === 0) {
        releaseRefresh();
        await refreshFinishedPromise;
      }
    }
    expect(detectEnvironment).toHaveBeenCalledTimes(2);
    fail(new Error('unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
    expect(detectEnvironment).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5_001);
    await apiRequest(app, '/api/v1/health');
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks: [{ name: 'omp', available: false }] });
  } finally { vi.useRealTimers(); }
});

it.each([false, true])('publishes completed availability without a health subscriber (early=%s)', async (early) => {
  const checks: BackendCheck[] = [{ name: 'omp', available: true, version: '1' }];
  let finish!: (checks: BackendCheck[]) => void;
  vi.mocked(detectEnvironment).mockReturnValue(early ? Promise.resolve(checks) : new Promise((resolve) => { finish = resolve; }));
  const events = new WorkspaceEventBus();
  const published = vi.fn(); events.on(published);
  const app = build(undefined, {
    workspaceEvents: events,
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: () => {}, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined },
  });
  if (!early) {
    expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks: [] });
    finish(checks);
  }
  await vi.waitFor(() => expect(published).toHaveBeenCalledWith('health', expect.objectContaining({ checks })), { timeout: HANG_GUARD_MS });
  expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
});

// hearsay-tools/squawk#3355: each Git spawn blocks this loop until the child execs.
it('publishes settled availability into the cached snapshot without reading Git again', async () => {
  const checks: BackendCheck[] = [{ name: 'omp', available: true, version: '1' }];
  let finish!: (checks: BackendCheck[]) => void;
  vi.mocked(detectEnvironment).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const repoInfo = vi.spyOn(git, 'getRepoInfo');
  const events = new WorkspaceEventBus();
  const settled = new Promise<unknown>((resolve) => {
    events.on((event, payload) => { if (event === 'health' && (payload as { checks: BackendCheck[] }).checks.length > 0) resolve(payload); });
  });
  const app = build(undefined, {
    workspaceEvents: events,
    providerAuth: new ProviderAuthService({ runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }) }),
    socketHub: { registerTopic: () => {}, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined },
  });
  const cold = await (await apiRequest(app, '/api/v1/health')).json() as { repoRoot: string };
  expect(cold).toMatchObject({ checks: [] });
  expect(repoInfo).toHaveBeenCalledOnce();
  finish(checks);
  expect(await settled).toMatchObject({ checks, repoRoot: cold.repoRoot });
  expect(await (await apiRequest(app, '/api/v1/health')).json()).toMatchObject({ checks });
  expect(repoInfo).toHaveBeenCalledOnce();
});
