import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { POWERSHELL } from '../core/process-stat.ts';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
      const keeper: EventEmitter & { stdin: { ended: boolean; end: () => void }; exitCode: null; signalCode: null } =
        Object.assign(new EventEmitter(), { stdin: { ended: false, end: () => { keeper.stdin.ended = true; keeper.emit('exit', 0); } }, exitCode: null, signalCode: null });
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
    expect(file).toBe(POWERSHELL);
    expect(args.slice(-3, -1)).toEqual(['run', workerJobName(workerId)]);
    // The argv travels in a private file, so the wrapper's own command line stays short.
    expect(readFileSync(args.at(-1)!, 'utf8').split('\0')).toEqual(['node.exe', 'agent.js', 'a b']);
    rmSync(args.at(-1)!, { force: true });
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
describe.runIf(process.platform === 'win32')('job backend on Windows', { timeout: 240_000 }, () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The controller's probe compiles the helper once; every later call loads the cached DLL.
  beforeAll(() => { expect(probeJobs()).toEqual({ ok: true }); }, 240_000);

  it('the worker ends with its controller, and an unrelated process survives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-job-controller-'));
    const pidFile = join(dir, 'worker.pid');
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const job = workerJobName(randomUUID());
    const controller = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const { jobCommand, realJobHelper } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'job.ts')).href)});
      realJobHelper.keep(${JSON.stringify(job)});
      const [file, args] = jobCommand(${JSON.stringify(job)}, process.execPath, ['-e', "require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(pidFile)}) + ", String(process.pid)); setInterval(() => {}, 1000)"]);
      spawn(file, args, { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    try {
      await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 120_000 }); // bound: PowerShell start and the job handshake
      const worker = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(worker)).toBe(true);
      controller.kill();
      await vi.waitFor(() => expect(alive(worker)).toBe(false), { timeout: 60_000 }); // bound: keeper exit after its stdin closes, then the job's kill
      expect(alive(sibling.pid!)).toBe(true);
    } finally { controller.kill(); sibling.kill(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('stop ends a descendant that outlived its leader', async () => {
    const memory = memoryStore(), workerId = randomUUID();
    const scopes = new WorkerScopes(memory.store, () => ({ backend: 'job' }));
    const [file, args] = scopes.spawnScope(workerId).command(process.execPath, ['-e',
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);"]);
    const run = spawnSync(file, args, { encoding: 'utf8', timeout: 180_000 });
    expect(run.error).toBeUndefined();
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
