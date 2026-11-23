import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { expect, it, vi } from 'vitest';
import { runnerInstallStatusSchema } from '@open-mercato/cezar-contract/runner-install';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { ManagedCliInstallation } from '../managed-install/cli-installation.ts';
import { resolveCapabilities } from './capabilities.ts';
import { createRunnerInstallRoutes } from './runner-install-routes.ts';

sealTestRunners(antigravityRunner);

it.each(['check', 'install', 'update', 'remove'])('refuses hosted %s without settingsAdmin before creating an installer', async action => {
  const home = testHome(); const create = vi.fn();
  const app = createRunnerInstallRoutes({ home, create,
    settingsAdmin: () => resolveCapabilities({ HSQ_REMOTE: '1' }, '0.0.0.0').settingsAdmin });
  const response = await app.request('/runner-install/antigravity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: expect.stringContaining('remote-settings enable') });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(create).not.toHaveBeenCalled();
  expect((await app.request('/runner-install/antigravity')).status).toBe(409);
});

it('returns exact status and accepts typed actions without waiting for installation', async () => {
  const home = testHome();
  const source = antigravityRunner.cli.installSource!;
  if (!('managed' in source)) throw new Error('Expected managed source');
  const service = new ManagedCliInstallation(home, 'antigravity', source.managed);
  const refresh = vi.spyOn(service, 'refreshIfDue').mockImplementation(() => {});
  const start = vi.spyOn(service, 'start').mockImplementation(() => {});
  const app = createRunnerInstallRoutes({ home, settingsAdmin: () => true, create: () => service });
  const response = await app.request('/runner-install/antigravity');
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(runnerInstallStatusSchema.parse(body)).toEqual(body);
  expect(refresh).toHaveBeenCalledOnce();
  const accepted = await app.request('/runner-install/antigravity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install' }) });
  expect(accepted.status).toBe(202); expect(start).toHaveBeenCalledWith('install');
  const acceptedBody: unknown = await accepted.json();
  expect(runnerInstallStatusSchema.parse(acceptedBody)).toEqual(acceptedBody);
  const invalid = await app.request('/runner-install/antigravity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'shell' }) });
  expect(invalid.status).toBe(400); expect(start).toHaveBeenCalledOnce();
  expect((await app.request('/runner-install/unknown')).status).toBe(400);
});
