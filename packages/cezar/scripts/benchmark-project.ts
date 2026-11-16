/**
 * What `serve` builds for one project, on a fresh temp Git repo, for the delegation benchmarks
 * (`benchmark-stuck-destroys.ts`, `benchmark-worker-lifecycle.ts`). Production cadence: no timer is
 * overridden. Import it after `prepareBenchmarkEnv()`, which points the home at a sandbox. To run a
 * benchmark on an older ref, copy this file beside it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerFactory } from '../src/core/agent-runner.ts';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';
import { benchmarkHome } from './benchmark-home.ts';

// Workspace receipts and markers use the host's identity store (ADR 0032).
installWindowsIdentityStore();

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export async function benchmarkProject(prefix: string, opts: { createRunner: RunnerFactory; maxParallel: number }) {
  const { RunStore } = await import('../src/runs/store.ts');
  const { RunManager } = await import('../src/workflows/run.ts');
  const home = benchmarkHome((await import('../src/home/resolve.ts')).resolveHome({ purpose: 'cli' }));
  const { DelegationService } = await import('../src/delegation/service.ts');
  const { acquireCiResources } = await import('../src/ci-wait/resources.ts');
  const { workerCleanups } = await import('../src/delegation/worker-cleanup.ts');
  const { WorkspaceSemaphore } = await import('../src/workspace/semaphore.ts');
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'gc.auto', '0');
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, '-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '--allow-empty', '-qm', 'base');
  const sha = git(root, 'rev-parse', 'HEAD');
  const dataDir = join(root, '.ai/cezar');
  const store = RunStore.open(dataDir, { keepLive: true });
  const manager = new RunManager(store, root, { home, createRunner: opts.createRunner,
    semaphore: new WorkspaceSemaphore({ home, initial: { maxParallel: opts.maxParallel } }), acquireCiResources });
  const service = new DelegationService(workerCleanups());
  const detach = service.registerProject({ id: 'bench', root, store, manager, home });
  return { root, sha, dataDir, store, manager, service, detach };
}
