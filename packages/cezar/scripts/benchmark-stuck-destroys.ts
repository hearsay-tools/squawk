import { spawnCapacityRefusal } from '../src/delegation/capacity.ts';
import { prepareBenchmarkEnv } from './benchmark-home.ts';
import { setRunStatus } from '../src/runs/run-store.testkit.ts';
/**
 * Stuck-destroy benchmark (hearsay-tools/cezarion#879): what permanently stuck worker destroys
 * cost an otherwise idle Squawk. Run it unchanged before and after a change to the cleanup loops.
 *
 *   npm run bench:stuck-destroys -w @wjarka/cezarion                       # 20 workers, 10 minutes
 *   node --import tsx packages/cezar/scripts/benchmark-stuck-destroys.ts --workers 0 --minutes 10
 *
 * Flags: --workers (20) --minutes (10) --out (a JSON file for the result row).
 *
 * Method:
 * - One process builds what `serve` builds for a project: `RunStore` (keepLive), `RunManager` and
 *   `DelegationService`, on a temp Git repo, with `CEZ_DRY_RUN=1` and production cadence (no
 *   timer is overridden).
 * - Each worker is settled the way a finished worker is: a complete execution checkpoint, status
 *   `review`, a real owned worktree and a local scratch dir. Its worktree is locked
 *   (`git worktree lock`), so Git never removes it and the destroy stays incomplete. A process
 *   working in the worktree no longer blocks a destroy (ADR 0032), so the lock is the blocker.
 * - Every worker is destroyed once through the human route, as Clean up does. Only then does the
 *   window start, so the measurement is the retry and reprobe loops alone.
 * - CPU is this process (`process.cpuUsage`, every thread) plus the children it reaped during the
 *   window (`/proc/self/stat` cutime/cstime: the git processes the loops spawn). Event-loop delay is
 *   what an HTTP request would wait.
 * - Compare N workers against `--workers 0`; the difference is what the stuck workers add.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { RunStore as RunStoreInstance } from '../src/runs/store.ts';
import type { RunManager as RunManagerInstance } from '../src/workflows/run.ts';
// This benchmark reads settled runs and starts no runner.
import { noRunners } from '../src/core/runners-under-test.testkit.ts';
import { installWindowsIdentityStore } from '../src/delegation/windows-identity-store.ts';
import { registerBuiltInRunners } from '../src/runners/built-in.ts';
import { registerBuiltInRunSlots } from '../src/built-in-run-slots.ts';

// Workspace receipts and markers use the host's identity store (ADR 0032).
installWindowsIdentityStore();
registerBuiltInRunners();
registerBuiltInRunSlots();

// The repo's own sandbox for ~/.cezar, so a benchmark never touches the user's registry; one this
// run creates is removed with the rest of its teardown.
const ownHome = prepareBenchmarkEnv();

const { values } = parseArgs({ options: {
  workers: { type: 'string', default: '20' },
  minutes: { type: 'string', default: '10' },
  out: { type: 'string' },
} });
const workers = Number(values.workers), minutes = Number(values.minutes);
if (!Number.isInteger(workers) || workers < 0 || !(minutes > 0)) throw new Error('--workers must be a whole number >= 0 and --minutes > 0');

const { benchmarkProject } = await import('./benchmark-project.ts');
const { planOwnedWorkspace, ensureOwnedWorkspace } = await import('../src/delegation/workspace.ts');
const { agentTmpDir } = await import('../src/runs/agent-tmpdir.ts');

/** Clock ticks of this process's reaped children (`cutime + cstime`), in ms; 0 off Linux. */
function childrenCpuMs(): number {
  if (process.platform !== 'linux') return 0;
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // After the comm field, cutime and cstime are fields 16 and 17 of stat(5), i.e. index 13 and 14 here.
  const ticks = Number(fields[13]) + Number(fields[14]);
  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  return ticks * 1000 / hz;
}

// Teardown runs however the run ends, so a failed setup, destroy or measurement leaves no
// temporary repository behind.
let store: RunStoreInstance | undefined, manager: RunManagerInstance | undefined, detach: (() => void) | undefined, root: string | undefined;
try {
  const project = await benchmarkProject('cez-bench-stuck-', { createRunner: noRunners, maxParallel: 1 });
  ({ store, manager, detach, root } = project);
  const { sha, dataDir, service } = project;
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  setRunStatus(store, parent.id, 'waiting', { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });

  const ids: string[] = [];
  for (let i = 0; i < workers; i++) {
    const id = randomUUID();
    const workspace = await planOwnedWorkspace(root, id, sha);
    store.createOwnedRun({ title: `worker ${i}`, task: 'stuck', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] },
      parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: parent.id, workspace }, 'a'.repeat(64), spawnCapacityRefusal);
    const generation = store.commitWorkerExecutionStart(id);
    const created = await ensureOwnedWorkspace(root, store.getRun(id)!);
    setRunStatus(store, id, 'review', { worktreePath: created.path, branch: created.branch });
    if (!store.commitWorkerExecutionComplete(id, generation)) throw new Error(`worker ${id} did not complete`);
    const scratch = agentTmpDir(dataDir, id);
    mkdirSync(scratch, { recursive: true });
    execFileSync('git', ['worktree', 'lock', '--reason', 'benchmark', created.path], { cwd: root });
    ids.push(id);
  }
  // What boot does after recovery: arm pending destroys and the scratch reprobes.
  service.armDestroyRetries('bench');
  for (const id of ids) {
    const result = await service.destroyForHuman('bench', id).catch((error: Error) => ({ state: 'error', error: error.message }));
    if (result.state === 'complete') throw new Error(`worker ${id} was not locked: its destroy completed`);
  }

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const cpu0 = process.cpuUsage(), children0 = childrenCpuMs(), wall0 = performance.now();
  await sleep(minutes * 60_000);
  const cpu = process.cpuUsage(cpu0), children = childrenCpuMs() - children0, wall = performance.now() - wall0;
  delay.disable();

  const opened = store;
  const pending = ids.filter(id => { const run = opened.getRun(id); return run?.delegation?.role === 'worker' && run.delegation.destroy?.phase !== 'complete'; }).length;
  const row = {
    workers, minutes, pendingDestroys: pending,
    userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000), childrenMs: Math.round(children),
    cpuPercent: Number(((cpu.user + cpu.system) / 1000 / wall * 100).toFixed(2)),
    cpuWithChildrenPercent: Number((((cpu.user + cpu.system) / 1000 + children) / wall * 100).toFixed(2)),
    loopDelayP99Ms: Number((delay.percentile(99) / 1e6).toFixed(1)), loopDelayMaxMs: Number((delay.max / 1e6).toFixed(1)),
    cores: cpus().length, node: process.version,
  };
  console.log('| workers | minutes | pending | user ms | system ms | children ms | CPU % | CPU % incl. children | loop p99 ms | loop max ms |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  console.log(`| ${row.workers} | ${row.minutes} | ${row.pendingDestroys} | ${row.userMs} | ${row.systemMs} | ${row.childrenMs} | ${row.cpuPercent} | ${row.cpuWithChildrenPercent} | ${row.loopDelayP99Ms} | ${row.loopDelayMaxMs} |`);
  if (values.out) writeFileSync(values.out, `${JSON.stringify(row, null, 2)}\n`);

} finally {
  detach?.();
  manager?.dispose();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  if (ownHome) rmSync(ownHome, { recursive: true, force: true });
}
process.exit(0);
