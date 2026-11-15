import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createRunner } from '../core/runner-factory.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import type { PreviewHost } from '../preview/host.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { createRunManager } from './run-manager.testkit.ts';
import { startServer } from './start-server.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 10_000;

/**
 * `shutdownForRestart` (#779): the old process stops its work, writes what is pending and frees
 * the port and every run claim, so the replacement process finds the live runs nobody's.
 */
describe('restart shutdown', () => {
  let home: string;
  let bootRoot: string;
  let otherRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-restart-home-'));
    bootRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-restart-boot-')));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-restart-other-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    useTestHome(Home.sandbox(home));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_PREVIEW', '1');
    vi.stubEnv('CEZ_REMOTE', '');
    vi.stubEnv('CEZ_PROJECT_WARMUP', '0');
    clearProjectProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
  });

  function connect(url: string): Promise<{ closed: () => boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let closed = false;
      ws.once('close', () => { closed = true; });
      ws.once('open', () => resolve({ closed: () => closed }));
      ws.once('error', reject);
    });
  }

  it('closes sockets and secondary projects and writes pending runs before it waits for delegation, then frees the port', async () => {
    const bootId = (await registerProject(bootRoot, undefined, testHome())).id;
    const otherId = (await registerProject(otherRoot, undefined, testHome())).id;
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: () => listProjects(testHome()) });
    await contexts.context(otherId);
    const dataDir = join(bootRoot, '.ai/cezar');
    const store = RunStore.open(dataDir, { keepLive: true });
    const run = store.createRun({ title: 'With a worktree', workflow: 'quick-task', task: 't', steps: [] });
    mkdirSync(join(bootRoot, 'wt'));
    store.updateRun(run.id, { worktreePath: join(bootRoot, 'wt') });
    // A dev server that will not stop must not abort the restart halfway.
    const previewHost = { handle: async () => undefined, detach: () => undefined, release: async () => undefined,
      close: async () => { throw new Error('dev server would not stop'); } } as unknown as PreviewHost;
    let delegationClosing = false;
    let finishDelegation!: () => void;
    const delegationClosed = new Promise<void>(resolve => { finishDelegation = resolve; });
    const delegation = { close: () => { delegationClosing = true; return delegationClosed; } } as unknown as DelegationController;
    const server = startServer({ home: testHome(), repoRoot: bootRoot, bootProjectId: bootId, store, manager: {} as RunManager,
      version: '0.0.0-test', contexts, previewHost, delegation }, 0);
    if (!server.listening) await once(server, 'listening');
    const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bus = await connect(`${base}/api/v1/ws`);
    const pane = await connect(`${base}/api/v1/runs/${run.id}/preview/ws`);
    store.updateRun(run.id, { title: 'Renamed before the restart' });

    let finished = false;
    const shutdown = server.shutdownForRestart().then(() => { finished = true; });
    await vi.waitFor(() => expect(delegationClosing).toBe(true), { timeout: HANG_GUARD_MS });
    await vi.waitFor(() => expect({ bus: bus.closed(), pane: pane.closed() }).toEqual({ bus: true, pane: true }), { timeout: HANG_GUARD_MS });
    expect(contexts.peek(otherId)).toBeUndefined();
    const reader = RunStore.open(dataDir, { keepLive: true });
    try { expect(reader.getRun(run.id)?.title).toBe('Renamed before the restart'); }
    finally { reader.close(); }
    expect(server.listening).toBe(true);

    finishDelegation();
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: HANG_GUARD_MS });
    await shutdown;
    expect(server.listening).toBe(false);
  });

  it('ends open event streams and releases every run claim for the replacement process', async () => {
    const dataDir = join(bootRoot, '.ai/cezar');
    const store = RunStore.open(dataDir, { keepLive: true });
    const run = store.createRun({ title: 'Running across the restart', workflow: 'quick-task', task: 't', steps: [] });
    store.move(run.id, 'start');
    const server = startServer({ home: testHome(), repoRoot: bootRoot, store, manager: {} as RunManager, version: '0.0.0-test' }, 0);
    if (!server.listening) await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    let streamEnded = false;
    await new Promise<void>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/api/v1/events' }, response => {
        expect(response.headers['content-type']).toContain('text/event-stream');
        response.on('close', () => { streamEnded = true; });
        response.resume();
        resolve();
      }).on('error', reject);
    });

    let finished = false;
    void server.shutdownForRestart().then(() => { finished = true; });
    // bound: an event stream left open would hold `server.close` forever.
    await vi.waitFor(() => expect({ finished, streamEnded }).toEqual({ finished: true, streamEnded: true }), { timeout: HANG_GUARD_MS });
    expect(server.listening).toBe(false);
    const replacement = RunStore.open(dataDir, { keepLive: true });
    try {
      expect(replacement.getRun(run.id)?.status).toBe('running');
      expect(replacement.listForeignClaimedRunIds()).toEqual([]);
    } finally { replacement.close(); }
  });
});
