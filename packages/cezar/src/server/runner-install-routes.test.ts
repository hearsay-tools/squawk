import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runnerInstallStatusSchema } from '@open-mercato/cezar-contract/runner-install';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';
import { defineRunner } from '../core/runner-definition.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import type { Home } from '../home/home.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { buildTestCliArchive, cleanupManagedCliHome } from '../managed-install/cli-archive.testkit.ts';
import { ManagedCliInstallation, leaseManagedCli, managedCliExecutable } from '../managed-install/cli-installation.ts';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { resolveCapabilities } from './capabilities.ts';
import { createRunnerInstallRoutes } from './runner-install-routes.ts';
import { readRunners } from './runners-routes.ts';

/**
 * Second runner with a distinct manifest shape (`{ release: { tag, assetUrl, sha256 } }`, SHA-256).
 * Proves a managed CLI runner installs through `/api/v1/runner-install/:runner` with zero edits
 * outside its own definition (hearsay-tools/squawk#4100).
 */
const fixtureManagedSource: ManagedCliSource = {
  manifestUrl: 'https://fixture-cli.example/releases/{target}/manifest.json',
  downloadUrlPrefix: 'https://downloads.fixture-cli.example/builds/',
  executable: 'fixture-cli',
  windowsExecutable: 'fixture-cli.exe',
  parseManifest(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid fixture manifest.');
    const release = (raw as { release?: unknown }).release;
    if (release === null || typeof release !== 'object' || Array.isArray(release)) throw new Error('Missing release block.');
    const record = release as Record<string, unknown>;
    if (typeof record.tag !== 'string' || typeof record.assetUrl !== 'string' || typeof record.sha256 !== 'string') {
      throw new Error('Missing release.tag, release.assetUrl, or release.sha256.');
    }
    return {
      version: record.tag.replace(/^v/, ''),
      url: record.assetUrl,
      digest: { algorithm: 'sha256', value: record.sha256 },
    };
  },
};

const fixtureManagedRunner = defineRunner({
  ...fixtureRunner,
  id: 'fixture-managed',
  cli: { ...fixtureRunner.cli, installSource: { managed: fixtureManagedSource } },
});

sealTestRunners(antigravityRunner, fixtureManagedRunner);

const homes: Home[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) cleanupManagedCliHome(home);
});

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

it('installs, leases, and removes a second fixture runner with a different manifest shape and sha256 through the same routes', async () => {
  const home = testHome(); homes.push(home);
  const asset = buildTestCliArchive('2.3.4', 'fixture-cli');
  const sha256 = createHash('sha256').update(asset).digest('hex');
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.startsWith('https://fixture-cli.example/releases/')) {
      return Response.json({
        release: {
          tag: 'v2.3.4',
          assetUrl: `${fixtureManagedSource.downloadUrlPrefix}2.3.4/fixture-cli.tar.gz`,
          sha256,
        },
      });
    }
    if (url === `${fixtureManagedSource.downloadUrlPrefix}2.3.4/fixture-cli.tar.gz`) {
      return new Response(new Uint8Array(asset));
    }
    return new Response('not found', { status: 404 });
  });

  expect(readRunners().runners.find(entry => entry.id === 'fixture-managed')?.managedInstall).toBe(true);

  let created: ManagedCliInstallation | undefined;
  const app = createRunnerInstallRoutes({
    home,
    settingsAdmin: () => true,
    create: (runner, source) => (created = new ManagedCliInstallation(home, runner, source, fetcher)),
  });

  // Initial GET checks the custom manifest shape asynchronously.
  const initial = await app.request('/runner-install/fixture-managed');
  expect(initial.status).toBe(200);
  expect(created).toBeDefined();
  await created!.settled();

  const checked = await app.request('/runner-install/fixture-managed');
  expect(checked.status).toBe(200);
  expect(runnerInstallStatusSchema.parse(await checked.json())).toEqual({
    supported: true, installedVersion: null, latestVersion: '2.3.4', updateAvailable: false, phase: 'idle', error: null,
  });

  // POST install downloads, verifies sha256, extracts, verifies --version, and activates.
  const startInstall = await app.request('/runner-install/fixture-managed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install' }),
  });
  expect(startInstall.status).toBe(202);
  await created!.settled();

  const afterInstall = await app.request('/runner-install/fixture-managed');
  expect(afterInstall.status).toBe(200);
  expect(runnerInstallStatusSchema.parse(await afterInstall.json())).toEqual({
    supported: true, installedVersion: '2.3.4', latestVersion: '2.3.4', updateAvailable: false, phase: 'idle', error: null,
  });

  const executable = managedCliExecutable(home, 'fixture-managed', fixtureManagedSource)!;
  expect(executable).toBeTruthy();
  expect(basename(dirname(executable))).toBe(sha256);
  expect(readFileSync(executable, 'utf8')).toContain('2.3.4');

  // Lease survives removal until released.
  const lease = leaseManagedCli(home, 'fixture-managed', fixtureManagedSource)!;
  expect(lease).not.toBeNull();
  const startRemove = await app.request('/runner-install/fixture-managed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove' }),
  });
  expect(startRemove.status).toBe(202);
  await created!.settled();
  expect(managedCliExecutable(home, 'fixture-managed', fixtureManagedSource)).toBeNull();
  expect(existsSync(lease.executable)).toBe(true);
  lease.release();
  expect(existsSync(dirname(lease.executable))).toBe(false);
});
