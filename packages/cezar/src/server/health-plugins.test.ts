import '../built-in-wait-kinds.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@open-mercato/cezar-contract/health';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { PluginLoadReport } from '../plugin/loader.ts';
import { createApp } from './server.ts';
import type { TopicPublisher } from './ws.ts';
import { apiRequest } from './loopback-request.testkit.ts';

sealTestRunners(claudeRunner);

const SETUP_TEXT = 'setup failed or a registration was refused; run `hsq plugins` on the host for the error';
const none = { runners: [], agentTools: [], waitKinds: [], stepKinds: [], cliCommands: [], removalSlots: 0, runLifecycleListeners: 0 };
const report = vi.hoisted(() => ({ current: undefined as PluginLoadReport | undefined }));
vi.mock('../plugin/loader.ts', async original => {
  const actual = await original<typeof import('../plugin/loader.ts')>();
  return { ...actual, pluginLoadReport: () => report.current ?? actual.pluginLoadReport() };
});

describe('GET /api/v1/health — plugins', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'hsq-health-plugins-'));
    store = RunStore.open(join(repoRoot, '.ai/squawk'));
    vi.stubEnv('CEZ_REMOTE', '');
    vi.stubEnv('HSQ_REMOTE', '');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    report.current = undefined;
  });
  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // A socket hub makes the app answer health from its cache, as the live server does.
  const socketHub = { registerTopic: () => {}, registerTopicFamily: () => {}, handleUpgrade: () => {}, close: () => {}, onClose: () => () => undefined };
  const health = async (app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' })) => {
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.status).toBe(200);
    return healthResponseSchema.parse(await res.json());
  };

  const loaded: PluginLoadReport = {
    folders: ['/home/me/.config/squawk/plugins'],
    loaded: [{ name: 'good', source: 'host', path: '/home/me/.config/squawk/plugins/good', contributions: none }],
    failed: [{ name: 'bad', source: 'host', path: '/home/me/.config/squawk/plugins/bad', reason: 'setup', error: 'setup broke in /home/me/.config/squawk/plugins/bad/index.mjs with token=sk-secret' }],
  };

  it('sends two empty lists when no plugin loaded', async () => {
    expect((await health()).plugins).toEqual({ loaded: [], failed: [] });
  });

  it('sends loaded and skipped plugins with their folders to a local cockpit', async () => {
    report.current = loaded;
    expect((await health()).plugins).toEqual({
      loaded: [{ name: 'good', source: 'host', path: '/home/me/.config/squawk/plugins/good' }],
      failed: [{ name: 'bad', source: 'host', path: '/home/me/.config/squawk/plugins/bad', error: SETUP_TEXT }],
    });
  });

  it('sends no host path when HSQ_REMOTE=1', async () => {
    vi.stubEnv('HSQ_REMOTE', '1');
    report.current = loaded;
    const body = await health();
    expect(body.capabilities.localHandoff).toBe(false);
    expect(body.plugins).toEqual({
      loaded: [{ name: 'good', source: 'host' }],
      failed: [{ name: 'bad', source: 'host', error: SETUP_TEXT }],
    });
    expect(JSON.stringify(body.plugins)).not.toContain('/home/me');
    expect(JSON.stringify(body.plugins)).not.toContain('sk-secret');
  });

  const initRepo = () => {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repoRoot });
  };

  it('sends no host path from a snapshot cached before the cockpit became hosted', async () => {
    initRepo();
    const realRoot = realpathSync(repoRoot);
    report.current = loaded;
    const app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', socketHub });
    const localBody = await health(app);
    expect(localBody.plugins.loaded[0]!.path).toBe('/home/me/.config/squawk/plugins/good');
    expect(localBody.repo?.root).toBe(realRoot);
    vi.stubEnv('HSQ_REMOTE', '1');
    const body = await health(app);
    expect(body.capabilities.localHandoff).toBe(false);
    expect(body.repoRoot).toBe(basename(repoRoot));
    expect(body.repo?.root).toBe(basename(realRoot));
    expect(body.repo?.root).not.toContain(sep);
    expect(JSON.stringify(body)).not.toContain(realRoot);
    expect(JSON.stringify(body.plugins)).not.toContain('/home/me');
    // Returning to local mode within the cache TTL restores the full host repo root.
    vi.stubEnv('HSQ_REMOTE', '');
    expect((await health(app)).repo?.root).toBe(realRoot);
  });

  it('pushes no host path from a snapshot cached before the cockpit became hosted', async () => {
    initRepo();
    const realRoot = realpathSync(repoRoot);
    report.current = loaded;
    let settleDetection: (checks: Array<{ name: string; available: boolean }>) => void = () => {};
    const detectEnvironment = () => new Promise<Array<{ name: string; available: boolean }>>(resolve => { settleDetection = resolve; });
    let publisher: TopicPublisher | undefined;
    const hub = { ...socketHub, registerTopic: (name: string, topic: TopicPublisher) => { if (name === 'health') publisher = topic; } };
    const app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', socketHub: hub, detectEnvironment });
    const localBody = await health(app);
    expect(localBody.plugins.loaded[0]!.path).toBe('/home/me/.config/squawk/plugins/good');
    expect(localBody.repo?.root).toBe(realRoot);
    const pushed: unknown[] = [];
    const stop = publisher!.start(payload => pushed.push(payload));
    try {
      vi.stubEnv('HSQ_REMOTE', '1');
      // A settled detection patches the cached local snapshot and pushes it.
      settleDetection([{ name: 'codex', available: true }]);
      // bound: the push follows one microtask chain; the default wait budget is only a hang guard.
      await vi.waitFor(() => expect(pushed).toHaveLength(1));
      const body = healthResponseSchema.parse(pushed[0]);
      expect(body.checks).toEqual([{ name: 'codex', available: true }]);
      expect(body.capabilities.localHandoff).toBe(false);
      expect(body.repoRoot).toBe(basename(repoRoot));
      expect(body.repo?.root).toBe(basename(realRoot));
      expect(body.repo?.root).not.toContain(sep);
      expect(JSON.stringify(body)).not.toContain(realRoot);
      expect(JSON.stringify(body.plugins)).not.toContain('/home/me');
    } finally {
      stop();
    }
  });
});
