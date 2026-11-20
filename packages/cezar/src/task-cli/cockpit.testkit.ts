import '../core/register-all-runners.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { createApp } from '../server/server.ts';
import { FakeRunManager } from '../server/fake-run-manager.testkit.ts';
import type { Cockpit } from './http.ts';
import { createRunner } from '../core/runner-registry.ts';


/**
 * A real cockpit app on a real loopback socket for `cez task` tests (#504), over `FakeRunManager`
 * (hearsay-tools/squawk#3937): every run stays `queued` and nothing spawns; tests move runs to
 * other states through the store, the way the engine would.
 */
export interface TestCockpit {
  repoRoot: string;
  store: RunStore;
  automationStore: AutomationStore;
  manager: FakeRunManager;
  cockpit: Cockpit;
  close(): Promise<void>;
}

export async function startTestCockpit(): Promise<TestCockpit> {
  const savedDryRun = process.env.CEZ_DRY_RUN;
  process.env.CEZ_DRY_RUN = '1';
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-task-cli-'));
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  const manager = new FakeRunManager(store, repoRoot, { createRunner, home: testHome() });
  const automationStore = AutomationStore.open(join(repoRoot, '.ai/cezar'));
  const app = createApp({ home: testHome(), repoRoot, store, manager, automationStore, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    repoRoot, store, manager, automationStore,
    cockpit: { origin, projectId: 'default', api: `${origin}/api/v1/p/default` },
    async close() {
      // SSE handlers hold connections open; drop them so close() can finish.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      manager.dispose();
      store.close();
      rmSync(repoRoot, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    },
  };
}
