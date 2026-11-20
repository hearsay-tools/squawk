import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os'; // test-home-read: checks refusal of the pinned test home; never writes it.
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { RunManager } from '../workflows/run.ts';
import type { InstallContext } from '../server-install/types.ts';
import { testHome } from './test-home.testkit.ts';
import { productIdentity } from './identity.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createUbuntuVps } from '../server-install/platforms/ubuntu-vps.ts';
import { previewRefusal } from '../ci-wait/errors.ts';
import { listAgentConfig } from '../agent-config/service.ts';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
registerRunner(claudeRunner);

// The agent-config listing reads every runner's config files.

it('names the product in an API refusal and installer label without changing their contracts', async () => {
  const { displayName: name, command } = productIdentity();
  const refusedRoot = homedir(); // test-home-read: the API must reject the pinned OS home, not an arbitrary sandbox folder.
  const step = createUbuntuVps().steps({ state: {} } as InstallContext).find(step => step.id === 'autostart');
  expect(step?.title).toBe(`Run ${name} as a service (systemd — starts now + on boot)`);
  expect(previewRefusal('headless').message).toBe(`No cockpit is attached to this run (\`${command} run\`).`);
  const listing = await listAgentConfig('/unused', {}, false);
  expect(listing.files.find(file => file.readOnlyReason)?.readOnlyReason).toContain(`run \`${command} remote-settings enable\``);
  const root = mkdtempSync(join(tmpdir(), 'display-server-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  try {
    const app = createApp({ home: testHome(), repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const response = await apiRequest(app, '/api/v1/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: refusedRoot }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `not a project folder: ${refusedRoot} is your home directory or a ${name} task worktree` });
  } finally {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  }
});
