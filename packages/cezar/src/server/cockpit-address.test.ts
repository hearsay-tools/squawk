import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { startServer } from './start-server.ts';
import { createRunner } from '../core/runner-registry.ts';
import { createRunManager } from './run-manager.testkit.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

/**
 * #774: the cockpit hands every project's RunManager the address it BOUND (`--port 0` asks for an
 * ephemeral one) and that project's own id, so `cez automation` inside an agent calls this
 * cockpit and never probes ports. A project built after listening gets it too.
 */
describe('startServer cockpit address', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, warmup: process.env.CEZ_PROJECT_WARMUP };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-address-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-address-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-address-other-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    useTestHome(home ? Home.sandbox(home) : undefined);
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECT_WARMUP;
    clearProjectProbeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_PROJECT_WARMUP', saved.warmup]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('addresses the boot manager and every built project with the bound port and its own id', async () => {
    const bootId = (await registerProject(bootRoot, undefined, testHome())).id;
    const otherId = (await registerProject(otherRoot, undefined, testHome())).id;
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: () => listProjects(testHome())});
    const setCockpitAddress = vi.fn();
    const server = startServer({ home: testHome(),
      repoRoot: bootRoot,
      bootProjectId: bootId,
      store,
      manager: { isActive: () => false, setCockpitAddress } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    }, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(setCockpitAddress).toHaveBeenCalledWith({ origin, projectId: bootId });
      // Built by the background warm-up after listening.
      await vi.waitFor(() => expect(contexts.peek(otherId)).toBeDefined(), { timeout: 10_000, interval: 20 });
      expect(contexts.peek(otherId)!.manager.cockpitAddress()).toEqual({ origin, projectId: otherId });
    } finally {
      server.close();
      contexts.disposeAll();
      store.close();
    }
  }, 15_000);

  it('addresses a project context built before the cockpit listens', async () => {
    const bootId = (await registerProject(bootRoot, undefined, testHome())).id;
    const otherId = (await registerProject(otherRoot, undefined, testHome())).id;
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: () => listProjects(testHome())});
    const built = await contexts.context(otherId);
    const server = startServer({ home: testHome(), repoRoot: bootRoot, bootProjectId: bootId, store,
      manager: { isActive: () => false, setCockpitAddress: vi.fn() } as unknown as RunManager, version: '0.0.0-test', contexts }, 0);
    try {
      if (!server.listening) await once(server, 'listening');
      expect(built.manager.cockpitAddress()).toEqual({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, projectId: otherId });
    } finally {
      server.close();
      await contexts.disposeAll();
      store.close();
    }
  });

  it('addresses the requested port when the supplied listener is bound to a socket path', async () => {
    const bootId = (await registerProject(bootRoot, undefined, testHome())).id;
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const manager = createRunManager(store, bootRoot, { home: testHome(), createRunner });
    const socketDir = mkdtempSync(join(tmpdir(), 'cez-address-socket-'));
    const listener = createServer();
    listener.listen(join(socketDir, 'cockpit.sock'));
    await once(listener, 'listening');
    const server = startServer({ home: testHome(), repoRoot: bootRoot, bootProjectId: bootId, store, manager, version: '0.0.0-test' }, 4321, listener);
    try {
      expect(manager.cockpitAddress()).toEqual({ origin: 'http://127.0.0.1:4321', projectId: bootId });
    } finally {
      await new Promise(resolve => server.close(resolve));
      manager.dispose();
      store.close();
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
