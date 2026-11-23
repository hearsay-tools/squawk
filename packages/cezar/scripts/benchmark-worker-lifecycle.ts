import { prepareBenchmarkRuntime } from './benchmark-runtime.ts';
import { spawnCapacityRefusal } from '../src/delegation/capacity.ts';
import { prepareBenchmarkEnv } from './benchmark-home.ts';
import { setRunStatus } from '../src/runs/run-store.testkit.ts';
/**
 * Worker lifecycle benchmark (hearsay-tools/squawk#2180): spawn and destroy latency of real owned
 * workers, run unchanged on the commit before worker process ownership and on one after it.
 *
 *   node --import tsx packages/cezar/scripts/benchmark-worker-lifecycle.ts --workers 10 --out row.json
 *
 * End to end (the same calls on both refs): one process builds what `serve` builds for a project
 * (`RunStore`, `RunManager`, `DelegationService`) on a temp Git repo, with the dry-run Claude mock.
 * - spawn: `createOwnedRun` + `enqueueOwnedRun` to the session's first recorded process, and to the
 *   worker's first settled turn; this includes worktree creation and setup-free start.
 * - destroy (clean): `destroyForHuman` on a settled worker.
 * - destroy (outside holder): the same, while an unrelated `sleep` works in the worktree. Before the
 *   change that holder refuses the destroy (`incomplete`); after it, it is ignored.
 * Every attempt is recorded with its state, incomplete ones included.
 *
 * Fixture (what this ref has, reported apart): before, the host-wide cwd scan destroy ran
 * (`inspectGeneration`); after, a worker scope's stop of a detached descendant.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ClaudeCliRunner } from '../src/runners/claude/claude-cli-runner.ts';
import { workerExecutionsOf } from '../src/delegation/worker-executions.ts';

prepareBenchmarkRuntime();
const ownHome = prepareBenchmarkEnv();
process.env.CEZ_DRY_RUN = '1'; process.env.CEZ_AUTONAME = '0'; process.env.CEZ_MOCK_NUDGE_REPLY = 'plain'; process.env.CEZ_MOCK_NOTES = '0';

const { values } = parseArgs({ options: { workers: { type: 'string', default: '10' }, out: { type: 'string' }, label: { type: 'string', default: '' } } });
const workers = Number(values.workers);
if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers must be a whole number >= 1');

const { benchmarkProject, git } = await import('./benchmark-project.ts');
const { planOwnedWorkspace } = await import('../src/delegation/workspace.ts');

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Number(s[Math.floor(s.length / 2)]!.toFixed(1)) : null; };
const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Number(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!.toFixed(1)) : null; };
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) { if (performance.now() > deadline) return false; await sleep(5); }
  return true;
}

const holders: ChildProcess[] = [];
const { root, sha, dataDir, store, manager, service, detach } = await benchmarkProject('cez-bench-lifecycle-', { createRunner: async () => new ClaudeCliRunner(), maxParallel: 4 });
try {
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
  setRunStatus(store, parent.id, 'waiting', { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  const processesFile = (id: string) => join(dataDir, 'runs', `${id}.processes.json`);
  const started = (id: string) => existsSync(processesFile(id)) && (JSON.parse(readFileSync(processesFile(id), 'utf8')) as { processes: unknown[] }).processes.length > 0;
  // A worker that ends its turn parks `waiting`; its execution stays open until destroy stops it.
  const settled = (id: string) => ['waiting', 'review', 'done', 'failed'].includes(store.getRun(id)?.status ?? '');

  const spawnToSession: number[] = [], spawnToSettled: number[] = [], spawned: string[] = [];
  // Every attempt's outcome, so a timed-out or failed start is counted, never dropped.
  const spawnOutcomes: Record<string, number> = {};
  const outcome = (key: string) => { spawnOutcomes[key] = (spawnOutcomes[key] ?? 0) + 1; };
  for (let i = 0; i < workers; i++) {
    const id = randomUUID();
    const t0 = performance.now();
    const workspace = await planOwnedWorkspace(root, id, sha);
    store.createOwnedRun({ title: `worker ${i}`, task: 'say hello', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] },
      parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: parent.id, workspace }, 'a'.repeat(64), spawnCapacityRefusal);
    manager.enqueueOwnedRun(id);
    if (await until(() => started(id), 60_000)) spawnToSession.push(performance.now() - t0);
    else outcome('no-session-within-60s');
    if (!await until(() => settled(id), 120_000)) { outcome(`not-settled-within-120s:${store.getRun(id)?.status}`); continue; }
    const status = store.getRun(id)!.status;
    outcome(status);
    // Only a worker whose turn ended cleanly is a spawn sample; a failed one is counted above.
    if (status === 'waiting' || status === 'review') { spawnToSettled.push(performance.now() - t0); spawned.push(id); }
  }

  const destroy = async (id: string) => {
    const t0 = performance.now();
    const result = await service.destroyForHuman('bench', id).catch((error: Error) => ({ state: 'error', error: error.message }));
    return { ms: performance.now() - t0, state: (result as { state: string }).state };
  };
  const half = Math.ceil(spawned.length / 2);
  const clean = [] as Array<{ ms: number; state: string }>, held = [] as Array<{ ms: number; state: string }>;
  for (const id of spawned.slice(0, half)) clean.push(await destroy(id));
  for (const id of spawned.slice(half)) {
    const run = store.getRun(id);
    const path = run?.delegation?.role === 'worker' ? run.delegation.workspace.path : root;
    const holder = spawn('sleep', ['600'], { cwd: path, stdio: 'ignore' }); holders.push(holder);
    held.push(await destroy(id));
    holder.kill('SIGKILL');
  }

  // Fixture: the primitive each ref runs.
  const fixture: Record<string, unknown> = {};
  const liveness = await import('../src/delegation/process-liveness.ts') as Record<string, unknown>;
  if (typeof liveness.inspectGeneration === 'function') {
    const scan = liveness.inspectGeneration as (input: { paths: string[] }) => unknown;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); scan({ paths: [root] }); times.push(performance.now() - t0); }
    fixture.cwdScanMedianMs = median(times); fixture.cwdScanP90Ms = p90(times);
    fixture.hostProcesses = execFileSync('sh', ['-c', 'ls /proc | grep -c "^[0-9]"'], { encoding: 'utf8' }).trim();
  }
  const scopesPath = '../src/worker-scope/worker-scopes.ts';
  const scopes = await import(scopesPath).catch(() => undefined) as typeof import('../src/worker-scope/worker-scopes.ts') | undefined;
  // A scope stop is measured only where the scope contains the setsid descendant; a `groups` host
  // does not (ADR 0032), and its stop would time a different, weaker thing.
  const host = scopes?.hostScope();
  if (host && host.backend === 'groups') fixture.scopeStopSkipped = `groups backend (${host.reason}) does not contain a setsid descendant`;
  if (scopes && host && host.backend !== 'groups') {
    const stops: number[] = [];
    let stopFailures = 0;
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      const scope = workerExecutionsOf(store).scopes.spawnScope(id);
      const [file, args] = scope.command('/bin/sh', ['-c', 'setsid sleep 600 & echo $!']);
      const leader = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      scope.started(leader.pid!);
      const descendant = Number(String(await new Promise(resolve => leader.stdout!.once('data', resolve))).trim());
      const t0 = performance.now();
      try {
        const stopped = await workerExecutionsOf(store).scopes.stop(id, 10_000);
        if (stopped.stopped) stops.push(performance.now() - t0); else stopFailures++;
      } catch { stopFailures++; } finally {
        // Ended whatever the stop did: nothing this fixture started outlives it.
        try { process.kill(descendant, 'SIGKILL'); } catch { /* the scope ended it */ }
      }
    }
    fixture.scopeBackend = host.backend; fixture.scopeStopMedianMs = median(stops); fixture.scopeStopP90Ms = p90(stops); fixture.scopeStopFailures = stopFailures;
  }

  const states = (rows: Array<{ state: string }>) => rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.state]: (acc[row.state] ?? 0) + 1 }), {});
  const row = {
    label: values.label, commit: git(process.cwd(), 'rev-parse', '--short', 'HEAD'), workers, spawned: spawned.length, spawnOutcomes,
    spawnToSessionMedianMs: median(spawnToSession), spawnToSessionP90Ms: p90(spawnToSession),
    spawnToSettledMedianMs: median(spawnToSettled), spawnToSettledP90Ms: p90(spawnToSettled),
    destroyCleanMedianMs: median(clean.map(r => r.ms)), destroyCleanStates: states(clean),
    destroyHeldMedianMs: median(held.map(r => r.ms)), destroyHeldStates: states(held),
    fixture, load1: Number(loadavg()[0]!.toFixed(1)), cores: cpus().length, node: process.version,
  };
  console.log(JSON.stringify(row, null, 2));
  if (values.out) writeFileSync(values.out, `${JSON.stringify(row, null, 2)}\n`);
} finally {
  for (const child of holders) child.kill('SIGKILL');
  detach();
  manager.dispose();
  store.close();
  rmSync(root, { recursive: true, force: true });
  if (ownHome) rmSync(ownHome, { recursive: true, force: true });
}
process.exit(0);
