import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Home } from '../home/home.ts';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';
import { recordedProcessLive, processStartToken } from '../core/process-stat.ts';
import { assertHomePath } from '../home/boundary.ts';
import { privateDirectory, replacePrivate } from '../home/private-files.ts';
import { withHomeLock } from '../home/write-lock.ts';
import { cliDigestSchema, cliReleaseId, managedCliTarget, type CliManifest } from './cli-manifest.ts';

const releaseIdSchema = z.string().regex(/^(?:[a-f0-9]{64}|(?:sha256|sha384)-[a-f0-9]{64})$/);
const activeSchema = z.object({ releaseId: releaseIdSchema });
const releaseSchema = z.object({
  releaseId: releaseIdSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  executable: z.string().regex(/^[a-zA-Z0-9._-]+$/), size: z.number().int().positive(),
  digest: cliDigestSchema.optional(),
});
const ownerSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().optional() });
const leaseSchema = ownerSchema.extend({ releaseId: releaseIdSchema });
export type ManagedRelease = z.infer<typeof releaseSchema> & { path: string };

export function cliRoot(home: Home, runner: string, target = managedCliTarget()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runner) || !target || !/^[a-z0-9_]+$/.test(target)) throw new Error('This CLI target is not supported.');
  return assertHomePath(home.data, join(home.data, 'tools', runner, target));
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function readActiveRelease(root: string, source: ManagedCliSource): ManagedRelease | null {
  const active = activeSchema.optional().parse(readJson(join(root, 'active.json')));
  if (!active) return null;
  const directory = assertHomePath(root, join(root, 'versions', active.releaseId));
  const value = readJson(join(directory, 'release.json'));
  if (value === undefined) return null;
  const release = releaseSchema.parse(value);
  const name = process.platform === 'win32' ? source.windowsExecutable : source.executable;
  if (release.releaseId !== active.releaseId || release.executable !== name) throw new Error('The managed CLI release record is invalid.');
  const path = assertHomePath(root, join(directory, name));
  const info = lstatSync(path);
  if (!info.isFile() || info.size !== release.size) throw new Error('The managed CLI executable is incomplete.');
  return { ...release, path };
}

export function managedCliExecutable(home: Home, runner: string, source: ManagedCliSource): string | null {
  if (!managedCliTarget()) return null;
  return readActiveRelease(cliRoot(home, runner), source)?.path ?? null;
}

function ownProcess() {
  const startToken = processStartToken(process.pid);
  return { pid: process.pid, ...(startToken ? { startToken } : {}) };
}

/** Short synchronous operations only; downloads never hold HomeStore's write lock. */
export function cliTransaction<T>(home: Home, operation: () => T): T {
  return withHomeLock(home.data, operation);
}

function liveLeases(root: string): Set<string> {
  const directory = join(root, 'leases');
  if (!existsSync(directory)) return new Set();
  const releases = new Set<string>();
  for (const name of readdirSync(directory)) {
    const path = assertHomePath(root, join(directory, name));
    const lease = leaseSchema.parse(readJson(path));
    if (recordedProcessLive(lease)) releases.add(lease.releaseId);
    else rmSync(path, { force: true });
  }
  return releases;
}

export function removeRelease(directory: string): void {
  // Only our flat, sealed release directories are removed. Never follow links.
  if (!lstatSync(directory).isDirectory()) throw new Error('The managed CLI release is not a directory.');
  chmodSync(directory, 0o700);
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error('The managed CLI release contains an unexpected entry.');
    chmodSync(path, 0o600);
  }
  rmSync(directory, { recursive: true });
}

/** Only the long install-claim holder calls this, so no live extraction can be removed. */
export function clearCliStaging(root: string): void {
  const versions = assertHomePath(root, join(root, 'versions'));
  if (!existsSync(versions)) return;
  for (const name of readdirSync(versions)) {
    if (/^\.stage-[a-f0-9-]{36}$/.test(name)) removeRelease(assertHomePath(root, join(versions, name)));
  }
}

/** Caller holds cliTransaction so lease acquisition and activation cannot race pruning. */
export function pruneCliReleases(root: string): void {
  const versions = join(root, 'versions');
  if (!existsSync(versions)) return;
  const active = activeSchema.optional().parse(readJson(join(root, 'active.json')))?.releaseId;
  const leased = liveLeases(root);
  for (const release of readdirSync(versions)) {
    if (releaseIdSchema.safeParse(release).success && release !== active && !leased.has(release)) {
      removeRelease(assertHomePath(root, join(versions, release)));
    }
  }
}

/** Pin before spawn. Bind to the child PID once started, then release after its exit. */
export function leaseManagedCli(home: Home, runner: string, source: ManagedCliSource) {
  const root = cliRoot(home, runner);
  return cliTransaction(home, () => {
    const release = readActiveRelease(root, source);
    if (!release) return null;
    const path = assertHomePath(root, join(root, 'leases', `${randomUUID()}.json`));
    replacePrivate(path, JSON.stringify({ ...ownProcess(), releaseId: release.releaseId }));
    let released = false;
    return {
      executable: release.path,
      version: release.version,
      bindProcess(pid: number) {
        cliTransaction(home, () => {
          if (released) throw new Error('The CLI lease has been released.');
          const owner = ownerSchema.parse({ pid, startToken: processStartToken(pid) });
          replacePrivate(path, JSON.stringify({ ...owner, releaseId: release.releaseId }));
        });
      },
      release() {
        cliTransaction(home, () => {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
          pruneCliReleases(root);
        });
      },
    };
  });
}

/** A persisted owner claim serializes long operations without blocking the event loop. */
export async function withCliInstallLock<T>(home: Home, root: string, operation: () => Promise<T>): Promise<T> {
  const path = assertHomePath(root, join(root, 'install-lock.json'));
  const deadline = Date.now() + 240_000;
  for (;;) {
    const acquired = cliTransaction(home, () => {
      const owner = ownerSchema.optional().parse(readJson(path));
      if (owner && recordedProcessLive(owner)) return false;
      replacePrivate(path, JSON.stringify(ownProcess()));
      return true;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw new Error('Another cockpit is still installing this CLI. Try again later.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  try { return await operation(); }
  finally { cliTransaction(home, () => rmSync(path, { force: true })); }
}

export function releaseMatchesManifest(release: Pick<ManagedRelease, 'releaseId' | 'version' | 'digest'>, manifest: Pick<CliManifest, 'digest' | 'version'>): boolean {
  const digest = cliDigestSchema.parse(manifest.digest);
  if (release.releaseId !== cliReleaseId(digest) || release.version !== manifest.version) return false;
  return !release.digest || (release.digest.algorithm === digest.algorithm && release.digest.value === digest.value);
}

export function activateCliRelease(root: string, stage: string, manifest: Pick<CliManifest, 'digest' | 'version'>, executable: string): void {
  const digest = cliDigestSchema.parse(manifest.digest);
  const releaseId = cliReleaseId(digest);
  const destination = assertHomePath(root, join(root, 'versions', releaseId));
  privateDirectory(join(root, 'versions'));
  if (!existsSync(destination)) {
    const path = join(stage, executable);
    const release = releaseSchema.parse({ releaseId, version: manifest.version, executable, size: statSync(path).size, digest });
    replacePrivate(join(stage, 'release.json'), JSON.stringify(release));
    chmodSync(path, 0o555);
    chmodSync(join(stage, 'release.json'), 0o444);
    chmodSync(stage, 0o555);
    renameSync(stage, destination);
  } else {
    const existing = releaseSchema.parse(readJson(join(destination, 'release.json')));
    if (existing.executable !== executable || !releaseMatchesManifest(existing, manifest)) {
      throw new Error('The managed CLI release directory conflicts with an existing release.');
    }
  }
  replacePrivate(join(root, 'active.json'), JSON.stringify({ releaseId }));
  pruneCliReleases(root);
}
