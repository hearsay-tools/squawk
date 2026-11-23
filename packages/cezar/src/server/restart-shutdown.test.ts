import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createRunner } from '../core/runner-registry.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import type { PreviewHost } from '../preview/host.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { createFakeRunManager } from './fake-run-manager.testkit.ts';
import { startServer } from './start-server.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

sealTestRunners(claudeRunner);

// bound: a hang guard only. Each awaited promise is the product's own signal and settles at once when it works.
function bounded<T>(signal: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} never came`)), 10_000); });
  return Promise.race([signal, guard]).finally(() => clearTimeout(timer));
}

/**
 * `shutdownForRestart` (hearsay-tools/cezarion#779): the old process stops its work, writes what is pending and frees
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

  /** A cockpit client socket and the promise of its close. */
  function connect(url: string): Promise<{ ws: WebSocket; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const closed = new Promise<void>(done => { ws.once('close', () => done()); });
      ws.once('open', () => resolve({ ws, closed }));
      ws.once('error', reject);
    });
  }

  it('closes sockets and secondary projects and writes pending runs before it waits for delegation, then frees the port', async () => {
    const bootId = (await registerProject(bootRoot, undefined, testHome())).id;
    const otherId = (await registerProject(otherRoot, undefined, testHome())).id;
    const contexts = new ProjectContexts({ createRunner, createManager: createFakeRunManager, home: testHome(), listProjects: () => listProjects(testHome()) });
    await contexts.context(otherId);
    const dataDir = join(bootRoot, '.ai/cezar');
    const store = RunStore.open(dataDir, { keepLive: true });
    const run = store.createRun({ title: 'With a worktree', workflow: 'quick-task', task: 't', steps: [] });
    mkdirSync(join(bootRoot, 'wt'));
    store.updateRun(run.id, { worktreePath: join(bootRoot, 'wt') });
    // A dev server that will not stop must not abort the restart halfway.
    const previewHost = { handle: async () => undefined, detach: () => undefined, release: async () => undefined,
      close: async () => { throw new Error('dev server would not stop'); } } as unknown as PreviewHost;
    let delegationClosing!: () => void;
    const closingDelegation = new Promise<void>(resolve => { delegationClosing = resolve; });
    let finishDelegation!: () => void;
    const delegationClosed = new Promise<void>(resolve => { finishDelegation = resolve; });
    const delegation = { close: () => { delegationClosing(); return delegationClosed; } } as unknown as DelegationController;
    const server = startServer({ home: testHome(), repoRoot: bootRoot, bootProjectId: bootId, store, manager: {} as RunManager,
      version: '0.0.0-test', contexts, previewHost, delegation }, 0);
    const sockets: WebSocket[] = [];
    let shutDown = false;
    try {
      if (!server.listening) await once(server, 'listening');
      const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const bus = await connect(`${base}/api/v1/ws`);
      sockets.push(bus.ws);
      const pane = await connect(`${base}/api/v1/runs/${run.id}/preview/ws`);
      sockets.push(pane.ws);
      store.updateRun(run.id, { title: 'Renamed before the restart' });

      const shutdown = server.shutdownForRestart();
      await bounded(closingDelegation, 'the delegation close');
      await bounded(Promise.all([bus.closed, pane.closed]), 'the socket closes');
      expect(contexts.peek(otherId)).toBeUndefined();
      const reader = RunStore.open(dataDir, { keepLive: true });
      try { expect(reader.getRun(run.id)?.title).toBe('Renamed before the restart'); }
      finally { reader.close(); }
      expect(server.listening).toBe(true);

      finishDelegation();
      await bounded(shutdown, 'the restart shutdown');
      shutDown = true;
      expect(server.listening).toBe(false);
    } finally {
      finishDelegation();
      for (const ws of sockets) ws.terminate();
      if (!shutDown) {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close();
        store.close();
      }
      await contexts.disposeAll();
    }
  });

  it('ends open event streams and releases every run claim for the replacement process', async () => {
    const dataDir = join(bootRoot, '.ai/cezar');
    const store = RunStore.open(dataDir, { keepLive: true });
    const run = store.createRun({ title: 'Running across the restart', workflow: 'quick-task', task: 't', steps: [] });
    store.move(run.id, 'start');
    const server = startServer({ home: testHome(), repoRoot: bootRoot, store, manager: {} as RunManager, version: '0.0.0-test' }, 0);
    let shutDown = false;
    try {
      if (!server.listening) await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const stream = await new Promise<{ closed: Promise<void> }>((resolve, reject) => {
        get({ host: '127.0.0.1', port, path: '/api/v1/events' }, response => {
          expect(response.headers['content-type']).toContain('text/event-stream');
          response.resume();
          resolve({ closed: new Promise<void>(done => { response.once('close', () => done()); }) });
        }).on('error', reject);
      });

      // An event stream left open would hold `server.close` forever.
      await bounded(Promise.all([server.shutdownForRestart(), stream.closed]), 'the restart shutdown and the stream close');
      shutDown = true;
      expect(server.listening).toBe(false);
      const replacement = RunStore.open(dataDir, { keepLive: true });
      try {
        expect(replacement.getRun(run.id)?.status).toBe('running');
        expect(replacement.claims.listForeignClaimedRunIds()).toEqual([]);
      } finally { replacement.close(); }
    } finally {
      if (!shutDown) {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close();
        store.close();
      }
    }
  });
});
