import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { jobCommand, probeJobs, workerJobName, type JobHelper } from './job.ts';
import type { ScopeRecord } from './scope.ts';
import { WorkerScopes, type ScopeStore } from './worker-scopes.ts';

/** A job helper that records calls; each job holds `active` processes until terminated. */
function fakeJobs() {
  const calls: string[][] = [];
  const keepers: Array<EventEmitter & { stdin: { end: () => void; ended: boolean }; exitCode: null; signalCode: null }> = [];
  const active = new Map<string, number>();
  const helper: JobHelper = {
    keep: job => {
      const keeper = Object.assign(new EventEmitter(), { stdin: { ended: false, end() { this.ended = true; } }, exitCode: null, signalCode: null });
      keepers.push(keeper); active.set(job, active.get(job) ?? 0);
      return keeper as never;
    },
    call: args => {
      calls.push(args);
      const [op, job] = args;
      if (op === 'terminate') { if (!active.has(job!)) return 'absent'; active.set(job!, 0); return 'empty'; }
      if (op === 'query') return active.has(job!) ? String(active.get(job!)) : 'absent';
      return 'ok';
    },
  };
  return { helper, calls, keepers, active };
}

function memoryStore() {
  let record: ScopeRecord | undefined;
  const store: ScopeStore = {
    readWorkerScope: () => record ?? 'absent', writeWorkerScope: (_id, next) => { record = next; },
    getRun: id => ({ id, delegation: { role: 'worker' } }) as unknown as RunRecord,
    readWorkerExecution: () => undefined, readWorkerProcesses: () => 'absent',
  };
  return { store, record: () => record };
}

describe('job backend', () => {
  it('records the worker job before starting its keeper once, and runs each command inside it', () => {
    const workerId = randomUUID(), jobs = fakeJobs(), memory = memoryStore();
    const scopes = new WorkerScopes(memory.store, () => ({ backend: 'job' }), jobs.helper);
    const [file, args] = scopes.spawnScope(workerId).command('node.exe', ['agent.js', 'a b']);
    expect([file, args]).toEqual(jobCommand(workerJobName(workerId), 'node.exe', ['agent.js', 'a b']));
    expect(JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString())).toEqual(['node.exe', 'agent.js', 'a b']);
    scopes.spawnScope(workerId).command('cmd.exe', []);
    expect(jobs.keepers).toHaveLength(1);
    expect(memory.record()).toMatchObject({ jobs: [workerJobName(workerId)] });
    expect(scopes.describe()).toEqual({ backend: 'job', guarantee: 'contained' });
  });

  it('stop terminates the job, closes its keeper and drops it from the record; empty asks the job', async () => {
    const workerId = randomUUID(), jobs = fakeJobs(), memory = memoryStore();
    const scopes = new WorkerScopes(memory.store, () => ({ backend: 'job' }), jobs.helper);
    scopes.spawnScope(workerId).command('node.exe', []);
    jobs.active.set(workerJobName(workerId), 2);
    expect(scopes.empty(workerId)).toBe(false);
    expect(await scopes.stop(workerId, 5_000)).toEqual({ stopped: true });
    expect(jobs.keepers[0]!.stdin.ended).toBe(true);
    expect(memory.record()).toMatchObject({ jobs: [] });
    expect(jobs.calls.some(([op]) => op === 'terminate')).toBe(true);
  });

  it('kill terminates without waiting, and a job that is gone is empty', () => {
    const workerId = randomUUID(), jobs = fakeJobs(), memory = memoryStore();
    const scopes = new WorkerScopes(memory.store, () => ({ backend: 'job' }), jobs.helper);
    scopes.spawnScope(workerId).command('node.exe', []);
    scopes.kill(workerId);
    expect(jobs.calls).toContainEqual(['terminate', workerJobName(workerId), '0']);
    jobs.active.delete(workerJobName(workerId));
    expect(scopes.stopped(workerId)).toBe(true);
  });

  it('a probe that fails names why, and the host falls back to process groups', () => {
    const failing: JobHelper = { keep: vi.fn(), call: () => { throw new Error('Access is denied.\nmore'); } };
    expect(probeJobs(failing)).toEqual({ reason: 'cannot run a process inside a job (Access is denied.)' });
  });
});

// Native Windows: the job ends a descendant that outlived its leader, and a command whose job never
// appears does not run.
describe.runIf(process.platform === 'win32')('job backend on Windows', { timeout: 120_000 }, () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('stop ends a descendant that outlived its leader', async () => {
    const memory = memoryStore(), workerId = randomUUID();
    const scopes = new WorkerScopes(memory.store, () => ({ backend: 'job' }));
    const [file, args] = scopes.spawnScope(workerId).command(process.execPath, ['-e',
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);"]);
    const run = spawnSync(file, args, { encoding: 'utf8', timeout: 90_000 });
    expect(run.status).toBe(0);
    const descendant = Number(run.stdout.trim().split('\n').at(-1));
    expect(alive(descendant)).toBe(true);
    expect(scopes.empty(workerId)).toBe(false);
    expect(await scopes.stop(workerId, 60_000)).toEqual({ stopped: true });
    await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 30_000 }); // bound: process exit after TerminateJobObject is asynchronous
  });

  it('a command whose job never appears does not run', () => {
    const [file, args] = jobCommand(workerJobName(randomUUID()), process.execPath, ['-e', 'console.log("ran")']);
    const run = spawnSync(file, args, { encoding: 'utf8', timeout: 90_000 });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('ran');
  });
});
