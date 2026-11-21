import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { ManagedCliInstallation, leaseManagedCli, managedCliExecutable } from './cli-installation.ts';
import { cliRoot, removeRelease } from './cli-storage.ts';
import { validateDownloadUrl } from './cli-manifest.ts';

const source = { manifestUrl: 'https://manifest.example/{target}.json', downloadUrlPrefix: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/', executable: 'antigravity', windowsExecutable: 'agy.exe' };
const homes: Home[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    const directory = join(cliRoot(home, 'antigravity'), 'versions');
    if (existsSync(directory)) for (const release of readdirSync(directory)) removeRelease(join(directory, release));
    rmSync(home.rootOverride!, { recursive: true, force: true });
  }
});

function archive(version: string, name = 'antigravity', kind = '0'): Buffer {
  const contents = Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000755\0', 100);
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write('ustar\0', 257);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc(512 - contents.length % 512), Buffer.alloc(1024)]));
}

function fixture() {
  const home = Home.sandbox(mkdtempSync(join(tmpdir(), 'managed-cli-'))); homes.push(home);
  let version = '1.0.0'; let asset = archive(version); let tamper = false;
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input).startsWith('https://manifest.example/')) return Response.json({
      version, url: `${source.downloadUrlPrefix}${version}/cli.tar.gz`, sha512: createHash('sha512').update(asset).digest('hex'),
    });
    return new Response(new Uint8Array(tamper ? Buffer.from('tampered') : asset));
  });
  return { home, fetcher, install: () => new ManagedCliInstallation(home, 'antigravity', source, fetcher),
    setAsset: (value: Buffer) => { asset = value; }, update: () => { version = '1.1.0'; asset = archive(version); },
    tamper: () => { tamper = true; } };
}

it('does no network work at construction or active-path lookup', () => {
  const f = fixture();
  expect(f.install().status().installedVersion).toBeNull();
  expect(managedCliExecutable(f.home, 'antigravity', source)).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('seals releases and keeps leases through update and removal', async () => {
  const f = fixture(); const installation = f.install();
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'idle', installedVersion: '1.0.0', error: null });
  const lease = leaseManagedCli(f.home, 'antigravity', source)!;
  expect(lease).not.toBeNull();
  expect(statSync(lease.executable).mode & 0o222).toBe(0);
  expect(statSync(dirname(lease.executable)).mode & 0o222).toBe(0);
  lease.bindProcess(process.pid);
  f.update(); installation.start('update'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'idle', installedVersion: '1.1.0' });
  expect(managedCliExecutable(f.home, 'antigravity', source)).not.toBe(lease.executable);
  expect(readFileSync(lease.executable, 'utf8')).toContain('1.0.0');
  installation.start('remove'); await installation.settled();
  expect(installation.status().installedVersion).toBeNull();
  expect(existsSync(lease.executable)).toBe(true);
  lease.release(); expect(existsSync(dirname(lease.executable))).toBe(false);
  lease.release();
});

it('refuses a sha512 mismatch without activating a release', async () => {
  const f = fixture(); f.tamper(); const installation = f.install();
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'failed', installedVersion: null, error: expect.stringContaining('sha512') });
  expect(existsSync(join(cliRoot(f.home, 'antigravity'), 'active.json'))).toBe(false);
});

it.each([['../escape', '0'], ['/absolute', '0'], ['antigravity', '2'], ['antigravity', '1']])('refuses archive entry %s of type %s', async (name, kind) => {
  const f = fixture(); f.setAsset(archive('1.0.0', name, kind)); const installation = f.install();
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'failed', installedVersion: null });
  expect(existsSync(join(cliRoot(f.home, 'antigravity'), 'escape'))).toBe(false);
});

it('keeps the active release when the downloaded binary reports the wrong version', async () => {
  const f = fixture(); const installation = f.install();
  installation.start('install'); await installation.settled();
  const original = managedCliExecutable(f.home, 'antigravity', source);
  f.update(); f.setAsset(archive('9.9.9')); installation.start('update'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'failed', installedVersion: '1.0.0', error: expect.stringContaining('version') });
  expect(managedCliExecutable(f.home, 'antigravity', source)).toBe(original);
});

it('serializes two independent installers sharing a home and downloads once', async () => {
  const f = fixture(); const first = f.install(); const second = f.install();
  first.start('install'); second.start('install');
  await Promise.all([first.settled(), second.settled()]);
  expect(first.status().phase).toBe('idle'); expect(second.status().phase).toBe('idle');
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).startsWith(source.downloadUrlPrefix))).toHaveLength(1);
  expect(readdirSync(join(cliRoot(f.home, 'antigravity'), 'versions'))).toHaveLength(1);
});

it.each(['http://storage.googleapis.com/antigravity-public/antigravity-cli/a', 'https://storage.googleapis.com.evil.test/antigravity-public/antigravity-cli/a', 'https://storage.googleapis.com/another-bucket/a', 'https://user:pass@storage.googleapis.com/antigravity-public/antigravity-cli/a', 'https://storage.googleapis.com/antigravity-public/antigravity-cli/%2e%2e/a'])('refuses untrusted download URL %s', url => {
  expect(() => validateDownloadUrl(source, url)).toThrow('not allowed');
});
