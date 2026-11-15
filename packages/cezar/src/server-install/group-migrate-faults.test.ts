import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readInstallMarker } from '../home/install-marker.ts';
import { migrateLegacyHome } from '../home/migrate.ts';
import { cleanStoreRoots } from '../home/store.testkit.ts';
import { readServerMigrateJournal, writeServerMigrateJournal } from './migrate-journal.ts';
import { loadServerState } from './state.ts';
import { installInstance, serverFixture, serverMigrate, type ServerFixture } from './server-migrate.testkit.ts';

// Pass-through until a test arms a fault; afterEach restores the real functions.
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), renameSync: vi.fn(fs.renameSync) };
});
afterEach(() => { vi.mocked(readFileSync).mockReset(); vi.mocked(renameSync).mockReset(); cleanStoreRoots(); });

const real = await vi.importActual<typeof import('node:fs')>('node:fs');

function oneInstance(): ServerFixture {
  const f = serverFixture();
  installInstance(f, { instance: 'default', port: 4321, domain: 'cockpit.example.com', tls: true });
  return f;
}

/** The first rename onto `path` fails as on a full disk; every other rename runs. */
function failRenameOnce(path: string): void {
  let failed = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (failed || to !== path) return real.renameSync(from, to);
    failed = true;
    throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${String(from)}' -> '${path}'`), { code: 'ENOSPC' });
  });
}

const unitName = (f: ServerFixture) => loadServerState('default', f.target).steps.autostart?.created?.artifacts.find(a => a.type === 'service')?.name;

describe('server-migrate under write faults and a concurrent home migration', () => {
  it('finishes the commit when MOVED.json cannot be written after the home committed', async () => {
    const f = oneInstance();
    failRenameOnce(join(f.legacy.root, 'MOVED.json'));
    const result = await serverMigrate(f);
    expect(result.status).toBe('migrated');
    expect(result.lines).toContainEqual(expect.stringMatching(/^server-migrate committed the home, then failed: ENOSPC: .*\. Finishing the commit\.$/));
    expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(true);
    expect(readInstallMarker(f.target.config)?.state).toBe('committed');
    expect(unitName(f)).toBe('hearsay-squawk.service');
    expect(f.host.unit('user', 'hearsay-squawk.service')).toMatchObject({ enabled: true, active: true });
    expect(f.host.unit('user', 'cezar.service')).toMatchObject({ active: false, starts: 0 });
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });

  it('finishes on the next run when a ledger write fails after the committing journal, without restarting the old service', async () => {
    const f = oneInstance();
    expect(migrateLegacyHome(f.legacy, f.target, { env: f.env }).status).toBe('migrated');
    failRenameOnce(f.target.serverState('default'));
    await expect(serverMigrate(f)).rejects.toThrow('ENOSPC');
    expect(readServerMigrateJournal(f.target)?.phase).toBe('committing');
    expect(unitName(f)).toBe('cezar.service');
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expect(unitName(f)).toBe('hearsay-squawk.service');
    expect(f.host.unit('user', 'hearsay-squawk.service')).toMatchObject({ enabled: true, active: true });
    expect(f.host.unit('user', 'cezar.service')).toMatchObject({ active: false, starts: 0 });
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });

  it('rolls a staged home back from a hand-edited journal that lists no instance, without rewriting that journal', async () => {
    const f = serverFixture();
    expect(migrateLegacyHome(f.legacy, f.target, { commit: false }).status).toBe('pending');
    writeServerMigrateJournal(f.target, { version: 1, phase: 'migrating', stagedHome: true, instances: [] });
    failRenameOnce(join(f.target.state, 'server-migrate.json'));
    // The recovery rolls the home back; then no completed install is left to migrate.
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'unchanged' });
    expect(readInstallMarker(f.target.config)?.state).toBeUndefined();
    expect(existsSync(join(f.target.config, 'install.json.failed'))).toBe(true);
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });

  it('moves nothing when another process commits the home right after the run decided to stage it', async () => {
    const f = oneInstance();
    const marker = join(f.target.config, 'install.json');
    let raced = false;
    // The first marker read after the service stopped decides whether this run stages the home.
    // `hsq migrate` in another process commits the home right after that read.
    vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof real.readFileSync>) => {
      if (raced || args[0] !== marker || f.host.unit('user', 'cezar.service').active) return real.readFileSync(...args);
      raced = true;
      try { return real.readFileSync(...args); } finally { migrateLegacyHome(f.legacy, f.target, { env: f.env }); }
    }) as typeof readFileSync);
    const result = await serverMigrate(f);
    expect(raced).toBe(true);
    expect(result.status).toBe('rolled-back');
    expect(result.lines).toContain('server-migrate failed: Expected a staged home, got unchanged. Rolling back every instance.');
    expect(readInstallMarker(f.target.config)?.state).toBe('committed');
    expect(f.host.unit('user', 'cezar.service')).toMatchObject({ enabled: true, active: true });
    expect(existsSync(join(f.host.userUnitDir, 'hearsay-squawk.service'))).toBe(false);
    expect(f.host.enabledSites()).toEqual(['cezar']);
    expect(unitName(f)).toBe('cezar.service');
    expect(readServerMigrateJournal(f.target)).toBeUndefined();
  });
});
