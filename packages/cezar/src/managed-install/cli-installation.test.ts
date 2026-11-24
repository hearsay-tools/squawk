import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';
import { Home } from '../home/home.ts';
import { ANTIGRAVITY_CLI, parseAntigravityManifest } from '../runners/antigravity/cli.ts';
import { buildTestCliArchive, cleanupManagedCliHome } from './cli-archive.testkit.ts';
import { ManagedCliInstallation, leaseManagedCli, managedCliExecutable } from './cli-installation.ts';
import { cliReleaseId, fetchCliManifest, managedCliTarget, validateDownloadUrl } from './cli-manifest.ts';
import { activateCliRelease, cliRoot, releaseMatchesManifest } from './cli-storage.ts';

const source: ManagedCliSource = {
  manifestUrl: 'https://manifest.example/{target}.json',
  downloadUrlPrefix: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/',
  executable: 'antigravity',
  windowsExecutable: 'agy.exe',
  parseManifest: ANTIGRAVITY_CLI.installSource.managed.parseManifest,
};
const homes: Home[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) cleanupManagedCliHome(home);
});

function fixture() {
  const home = Home.sandbox(mkdtempSync(join(tmpdir(), 'managed-cli-'))); homes.push(home);
  let version = '1.0.0'; let asset = buildTestCliArchive(version, 'antigravity'); let tamper = false;
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input).startsWith('https://manifest.example/')) return Response.json({
      version, url: `${source.downloadUrlPrefix}${version}/cli.tar.gz`, sha512: createHash('sha512').update(asset).digest('hex'),
    });
    return new Response(new Uint8Array(tamper ? Buffer.from('tampered') : asset));
  });
  return { home, fetcher, install: () => new ManagedCliInstallation(home, 'antigravity', source, fetcher),
    digest: () => createHash('sha512').update(asset).digest('hex'),
    setAsset: (value: Buffer) => { asset = value; }, update: () => { version = '1.1.0'; asset = buildTestCliArchive(version, 'antigravity'); },
    tamper: () => { tamper = true; } };
}

it('does no network work at construction or active-path lookup', () => {
  const f = fixture();
  expect(f.install().status().installedVersion).toBeNull();
  expect(managedCliExecutable(f.home, 'antigravity', source)).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('seals releases under the sha512-prefix layout and keeps leases through update and removal', async () => {
  const f = fixture(); const installation = f.install();
  const initialReleaseId = f.digest().slice(0, 64);
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'idle', installedVersion: '1.0.0', error: null });
  const lease = leaseManagedCli(f.home, 'antigravity', source)!;
  expect(lease).not.toBeNull();
  expect(basename(dirname(lease.executable))).toBe(initialReleaseId);
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
  const f = fixture(); f.setAsset(buildTestCliArchive('1.0.0', name, kind)); const installation = f.install();
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'failed', installedVersion: null });
  expect(existsSync(join(cliRoot(f.home, 'antigravity'), 'escape'))).toBe(false);
});

it('keeps the active release when the downloaded binary reports the wrong version', async () => {
  const f = fixture(); const installation = f.install();
  installation.start('install'); await installation.settled();
  const original = managedCliExecutable(f.home, 'antigravity', source);
  f.update(); f.setAsset(buildTestCliArchive('9.9.9', 'antigravity')); installation.start('update'); await installation.settled();
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

it.each([
  'http://storage.googleapis.com/antigravity-public/antigravity-cli/a',
  'https://storage.googleapis.com.evil.test/antigravity-public/antigravity-cli/a',
  'https://storage.googleapis.com/another-bucket/a',
  'https://user:pass@storage.googleapis.com/antigravity-public/antigravity-cli/a',
  'https://storage.googleapis.com/antigravity-public/antigravity-cli/%2e%2e/a',
])('refuses untrusted download URL %s', url => {
  expect(() => validateDownloadUrl(source, url)).toThrow('not allowed');
});

it('installs a runner with a custom manifest shape and sha256 digest and refuses sha256 tampering', async () => {
  const home = Home.sandbox(mkdtempSync(join(tmpdir(), 'managed-cli-sha256-'))); homes.push(home);
  const customSource: ManagedCliSource = {
    manifestUrl: 'https://releases.vendor.example/latest.json',
    downloadUrlPrefix: 'https://downloads.vendor.example/cli/',
    executable: 'vendor-cli',
    windowsExecutable: 'vendor-cli.exe',
    parseManifest(raw, { target }) {
      const data = raw as { release: { tag: string; assets: Record<string, { assetUrl: string; sha256: string }> } };
      const picked = data.release.assets[target];
      if (!picked) throw new Error(`Missing asset for ${target}`);
      return {
        version: data.release.tag.replace(/^v/, ''),
        url: picked.assetUrl,
        digest: { algorithm: 'sha256', value: picked.sha256 },
      };
    },
  };
  const asset = buildTestCliArchive('2.4.1', 'vendor-cli');
  const sha256 = createHash('sha256').update(asset).digest('hex');
  const target = managedCliTarget()!;
  let tamper = false;
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === customSource.manifestUrl) {
      return Response.json({
        release: {
          tag: 'v2.4.1',
          assets: { [target]: { assetUrl: `${customSource.downloadUrlPrefix}2.4.1/${target}.tar.gz`, sha256: sha256.toUpperCase() } },
        },
      });
    }
    return new Response(new Uint8Array(tamper ? Buffer.from('corrupt') : asset));
  });

  const installation = new ManagedCliInstallation(home, 'vendor', customSource, fetcher);
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'idle', installedVersion: '2.4.1', latestVersion: '2.4.1', updateAvailable: false, error: null });
  const executable = managedCliExecutable(home, 'vendor', customSource)!;
  expect(basename(dirname(executable))).toBe(`sha256-${sha256}`);

  // Tampered download with sha256 reports sha256 mismatch and refuses activation on a fresh home.
  tamper = true;
  const secondHome = Home.sandbox(mkdtempSync(join(tmpdir(), 'managed-cli-sha256-bad-'))); homes.push(secondHome);
  const badInstall = new ManagedCliInstallation(secondHome, 'vendor', customSource, fetcher);
  badInstall.start('install'); await badInstall.settled();
  expect(badInstall.status()).toMatchObject({ phase: 'failed', installedVersion: null, error: expect.stringContaining('sha256') });
});

it('supports sha384 digests and derives a 64-hex release directory id', async () => {
  const home = Home.sandbox(mkdtempSync(join(tmpdir(), 'managed-cli-sha384-'))); homes.push(home);
  const customSource: ManagedCliSource = {
    manifestUrl: 'https://releases.vendor.example/{target}.json',
    downloadUrlPrefix: 'https://downloads.vendor.example/cli/',
    executable: 'vendor-384',
    windowsExecutable: 'vendor-384.exe',
    parseManifest(raw) {
      const data = raw as { ver: string; download: string; digest384: string };
      return { version: data.ver, url: data.download, digest: { algorithm: 'sha384', value: data.digest384 } };
    },
  };
  const asset = buildTestCliArchive('3.0.0', 'vendor-384');
  const sha384 = createHash('sha384').update(asset).digest('hex');
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input).startsWith('https://releases.vendor.example/')) {
      return Response.json({ ver: '3.0.0', download: `${customSource.downloadUrlPrefix}3.0.0.tar.gz`, digest384: sha384 });
    }
    return new Response(new Uint8Array(asset));
  });
  const installation = new ManagedCliInstallation(home, 'vendor-384', customSource, fetcher);
  installation.start('install'); await installation.settled();
  expect(installation.status()).toMatchObject({ phase: 'idle', installedVersion: '3.0.0', error: null });
  expect(basename(dirname(managedCliExecutable(home, 'vendor-384', customSource)!))).toBe(`sha384-${sha384.slice(0, 64)}`);
});

it('keeps release ids disjoint across algorithms even when 64-hex prefixes match and checks full digests on reuse', async () => {
  const prefix = 'a'.repeat(64);
  const sha512First = { algorithm: 'sha512' as const, value: `${prefix}${'b'.repeat(64)}` };
  const sha512Second = { algorithm: 'sha512' as const, value: `${prefix}${'c'.repeat(64)}` };
  const sha512Id = cliReleaseId(sha512First);
  const sha256Id = cliReleaseId({ algorithm: 'sha256', value: prefix });
  const sha384Id = cliReleaseId({ algorithm: 'sha384', value: `${prefix}${'c'.repeat(32)}` });
  expect(sha512Id).toBe(prefix);
  expect(sha256Id).toBe(`sha256-${prefix}`);
  expect(sha384Id).toBe(`sha384-${prefix}`);
  expect(new Set([sha512Id, sha256Id, sha384Id]).size).toBe(3);

  // Full digest comparison distinguishes two sha512 manifests sharing a 64-hex prefix, and refuses unrecorded digests.
  expect(releaseMatchesManifest({ releaseId: sha512Id, version: '1.0.0', digest: sha512First }, { version: '1.0.0', digest: sha512First })).toBe(true);
  expect(releaseMatchesManifest({ releaseId: sha512Id, version: '1.0.0', digest: sha512First }, { version: '1.0.0', digest: sha512Second })).toBe(false);
  expect(releaseMatchesManifest({ releaseId: sha512Id, version: '1.0.0', digest: undefined }, { version: '1.0.0', digest: sha512First })).toBe(false);

  // Activating a different full sha512 digest into an existing 64-hex directory refuses reuse.
  const f = fixture(); const installation = f.install();
  installation.start('install'); await installation.settled();
  const digest = f.digest();
  const conflicting = `${digest.slice(0, 64)}${digest[64] === '0' ? '1' : '0'}${digest.slice(65)}`;
  const root = cliRoot(f.home, 'antigravity');
  expect(() => activateCliRelease(root, join(root, 'versions', '.stage-unused'), { version: '1.0.0', digest: { algorithm: 'sha512', value: conflicting } }, 'antigravity'))
    .toThrow('conflicts with an existing release');

  // A pre-upgrade release.json without digest still launches, re-verifies on update, and records full digest in active.json.
  const versionDir = join(root, 'versions', digest.slice(0, 64));
  const releasePath = join(versionDir, 'release.json');
  const legacyRecord = JSON.parse(readFileSync(releasePath, 'utf8')) as Record<string, unknown>;
  delete legacyRecord.digest;
  chmodSync(versionDir, 0o700); chmodSync(releasePath, 0o600);
  writeFileSync(releasePath, JSON.stringify(legacyRecord));
  chmodSync(releasePath, 0o444); chmodSync(versionDir, 0o555);
  writeFileSync(join(root, 'active.json'), JSON.stringify({ releaseId: digest.slice(0, 64) }));
  const upgraded = f.install();
  upgraded.start('check'); await upgraded.settled();
  expect(upgraded.status()).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true });
  upgraded.start('update'); await upgraded.settled();
  expect(upgraded.status()).toMatchObject({ phase: 'idle', installedVersion: '1.0.0', updateAvailable: false, error: null });
});

it.each([
  ['unsupported algorithm md5', { version: '1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'md5', value: 'a'.repeat(32) } }],
  ['unsupported algorithm sha1', { version: '1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'sha1', value: 'a'.repeat(40) } }],
  ['sha256 value with sha512 algorithm', { version: '1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'sha512', value: 'a'.repeat(64) } }],
  ['sha512 value with sha256 algorithm', { version: '1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'sha256', value: 'a'.repeat(128) } }],
  ['non-hex sha256 value', { version: '1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'sha256', value: 'g'.repeat(64) } }],
  ['non-semver version', { version: 'v1.0.0', url: `${source.downloadUrlPrefix}1.0.0/cli.tar.gz`, digest: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
  ['untrusted download URL from parser', { version: '1.0.0', url: 'https://evil.example/cli.tar.gz', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
])('strictly refuses invalid parser output: %s', async (_label, returned) => {
  const badSource: ManagedCliSource = {
    ...source,
    parseManifest: () => returned as unknown as ReturnType<ManagedCliSource['parseManifest']>,
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  await expect(fetchCliManifest(badSource, 'linux_amd64', fetcher)).rejects.toThrow();
});

it('rejects oversized manifests and invalid Antigravity payloads before activation', async () => {
  const hugeFetcher = vi.fn<typeof fetch>(async () => new Response('x'.repeat(16_385)));
  await expect(fetchCliManifest(source, 'linux_amd64', hugeFetcher)).rejects.toThrow('too large');
  expect(() => parseAntigravityManifest(null)).toThrow('invalid');
  expect(() => parseAntigravityManifest([])).toThrow('invalid');
  expect(() => parseAntigravityManifest({ version: '1.0.0', url: 'https://example.com/a' })).toThrow('missing');
  expect(() => parseAntigravityManifest({ version: '1.0.0', url: 'https://example.com/a', sha512: 'not-a-sha512' })).toThrow('sha512 is invalid');
});
