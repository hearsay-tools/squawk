import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerInstallAction, RunnerInstallStatus } from '@open-mercato/cezar-contract/runner-install';
import type { Home } from '../home/home.ts';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';
import { privateDirectory } from '../home/private-files.ts';
import { downloadCli, extractCliArchive } from './cli-archive.ts';
import { cliReleaseId, fetchCliManifest, managedCliTarget, type CliManifest } from './cli-manifest.ts';
import { activateCliRelease, clearCliStaging, cliRoot, cliTransaction, pruneCliReleases, readActiveRelease, removeRelease, withCliInstallLock } from './cli-storage.ts';

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const runFile = promisify(execFile);

/** Created at boot without I/O. Only Settings requests can fetch a manifest or install a CLI. */
export class ManagedCliInstallation {
  private phase: RunnerInstallStatus['phase'] = 'idle';
  private error: string | null = null;
  private latest: CliManifest | null = null;
  private checkedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly home: Home, private readonly runner: string, private readonly source: ManagedCliSource,
    private readonly fetcher: typeof fetch = fetch) {}

  status(): RunnerInstallStatus {
    const target = managedCliTarget();
    const active = target ? readActiveRelease(cliRoot(this.home, this.runner, target), this.source) : null;
    return {
      supported: target !== null,
      installedVersion: active?.version ?? null,
      latestVersion: this.latest?.version ?? null,
      updateAvailable: !!active && !!this.latest && active.releaseId !== cliReleaseId(this.latest.digest),
      phase: this.phase, error: this.error,
    };
  }

  /** A status read checks at most hourly while the pane is open. It never waits on the network. */
  refreshIfDue(): void {
    if (managedCliTarget() && !this.pending && Date.now() - this.checkedAt >= UPDATE_INTERVAL_MS) this.start('check');
  }

  start(action: RunnerInstallAction): void {
    if (this.pending) throw new Error('A CLI operation is already running.');
    const target = managedCliTarget();
    if (!target) throw new Error('This host is not supported by the managed CLI.');
    this.error = null;
    this.phase = action === 'remove' ? 'removing' : 'checking';
    this.pending = this.perform(action, target)
      .then(() => { this.phase = 'idle'; })
      .catch(error => { this.phase = 'failed'; this.error = error instanceof Error ? error.message : 'The CLI operation failed.'; })
      .finally(() => { this.pending = null; });
  }

  /** Used by verification and CLI callers; HTTP starts work and reads progress separately. */
  async settled(): Promise<void> { await this.pending; }

  private async manifest(target: string): Promise<CliManifest> {
    this.checkedAt = Date.now();
    this.latest = await fetchCliManifest(this.source, target, this.fetcher);
    return this.latest;
  }

  private async perform(action: RunnerInstallAction, target: string): Promise<void> {
    if (action === 'check') { await this.manifest(target); return; }
    const root = cliRoot(this.home, this.runner, target);
    await withCliInstallLock(this.home, root, async () => {
      clearCliStaging(root);
      if (action === 'remove') {
        cliTransaction(this.home, () => {
          rmSync(join(root, 'active.json'), { force: true });
          pruneCliReleases(root);
        });
        return;
      }
      const manifest = await this.manifest(target);
      const active = readActiveRelease(root, this.source);
      if (active?.releaseId === cliReleaseId(manifest.digest)) return;
      await this.install(root, manifest);
    });
  }

  private async install(root: string, manifest: CliManifest): Promise<void> {
    // A sealed directory can be renamed by its parent owner within the same directory.
    const stage = join(root, 'versions', `.stage-${randomUUID()}`);
    privateDirectory(stage);
    const archive = join(stage, 'download');
    const executable = process.platform === 'win32' ? this.source.windowsExecutable : this.source.executable;
    try {
      this.phase = 'downloading';
      await downloadCli(manifest, archive, this.fetcher);
      this.phase = 'extracting';
      if (process.platform === 'win32') {
        if (readFileSync(archive).subarray(0, 2).toString() !== 'MZ') throw new Error('The CLI executable is invalid.');
        copyFileSync(archive, join(stage, executable));
      } else await extractCliArchive(archive, join(stage, executable), executable);
      rmSync(archive);
      this.phase = 'verifying';
      const result = await runFile(join(stage, executable), ['--version'], { timeout: 5_000, maxBuffer: 4096, windowsHide: true });
      if (result.stdout.trim() !== manifest.version) throw new Error('The installed CLI version does not match the manifest.');
      this.phase = 'activating';
      cliTransaction(this.home, () => activateCliRelease(root, stage, manifest, executable));
    } finally {
      if (existsSync(stage)) removeRelease(stage);
    }
  }
}

export { managedCliExecutable, leaseManagedCli } from './cli-storage.ts';
