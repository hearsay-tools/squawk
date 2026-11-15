import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { copyPrivateTree, replacePrivateTree, writeLegacyArchive } from './migration-files.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { migrationFixture, rawJson } from './migration.testkit.ts';
import { migrateLegacyHome } from './migrate.ts';
import { BINARY_NAMES } from './identity.ts';
import { launcherFile } from '../managed-install/launcher.ts';

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(() => Buffer.alloc(0)),
}));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, symlinkSync: vi.fn(fs.symlinkSync) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); cleanStoreRoots(); });

it('D4: the Windows junction branch points current at the final version path after staged rename', () => {
  const source = storeRoot(), target = join(storeRoot(), 'versions');
  mkdirSync(join(source, 'v1'));
  writeFileSync(join(source, 'v1/entry'), 'junction bytes');
  symlinkSync(join(source, 'v1'), join(source, 'current'), 'junction');
  vi.mocked(symlinkSync).mockClear();
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  replacePrivateTree(source, target);
  expect(vi.mocked(symlinkSync).mock.calls).toContainEqual([join(target, 'v1'), expect.any(String), 'junction']);
  expect(readlinkSync(join(target, 'current'))).toContain('v1');
  expect(readFileSync(join(target, 'current/entry'), 'utf8')).toBe('junction bytes');
});

it('migration copies and archives request the split Windows private ACL', () => {
  const source = storeRoot(), target = join(storeRoot(), 'copy'), archive = join(storeRoot(), 'backups/archive.tar.gz');
  const home = migrationFixture();
  writeFileSync(join(source, 'auth.json'), '{"secret":"credential"}');
  rawJson(join(home.legacy.versions, 'v1/package.json'), { version: '1.0.0' });
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  copyPrivateTree(source, target);
  writeLegacyArchive(source, archive, ['auth.json']);
  expect(migrateLegacyHome(home.legacy, home.target).status).toBe('migrated');
  const aclCalls = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'powershell.exe');
  expect(aclCalls.length).toBeGreaterThanOrEqual(2);
  expect(aclCalls.every(([, args]) => String(args).includes('SetAccessRuleProtection($true, $false)'))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(target))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(join(archive, '..')))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(home.target.config))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(home.target.state))).toBe(true);
  for (const name of BINARY_NAMES) {
    expect(aclCalls.some(([, args]) => String(args).includes(launcherFile(home.target.bin, name, 'win32'))), name).toBe(true);
  }
  expect(readFileSync(join(target, 'auth.json'), 'utf8')).toBe('{"secret":"credential"}');
  expect(statSync(archive).size).toBeGreaterThan(0);
});

it('on Windows, three older-binary writes name the file even when the process list is unavailable', () => {
  const { legacy, target } = migrationFixture();
  let listing = false;
  vi.mocked(execFileSync).mockImplementation(() => {
    if (listing) throw new Error('powershell.exe is not available');
    return Buffer.alloc(0);
  });
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  try {
    expect(() => migrateLegacyHome(legacy, target, { onStep(step, attempt) {
      if (step !== 'recheck') return;
      rawJson(legacy.workspaceConfig, { projects: [], attempt });
      listing = attempt === 2;
    } })).toThrow(/kept changing after three checks: config\.json\..*Running processes \(pid and command\):\nprocess list unavailable$/s);
  } finally { vi.mocked(execFileSync).mockImplementation(() => Buffer.alloc(0)); }
});
