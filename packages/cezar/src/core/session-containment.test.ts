import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CgroupFs } from './os-cgroup.ts';
import { probeJobs, realJobHelper, startBreakawayProcess, terminateJob, type JobHelper } from './os-win-job.ts';
import {
  discardSessionContainer,
  executableReachable,
  prepareSessionContainer,
  reapSessionContainer,
  releaseSessionContainer,
  SESSION_CGROUP_PREFIX,
  SESSION_JOB_PREFIX,
  setSessionContainment,
  waitForSessionKeepers,
} from './session-containment.ts';
import { isNormalSessionExit, spawnSessionLeader } from './session-process.ts';

function fakeCgroupFs() {
  const dirs = new Set<string>(['/sys/fs/cgroup/app.slice/squawk.service', '/sys/fs/cgroup/app.slice/squawk.service/squawk-worker-w1']);
  const pids = new Map<string, number[]>();
  const log: string[] = [];
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const fs: CgroupFs = {
    readFile: path => {
      if (path === '/proc/self/cgroup') return '0::/app.slice/squawk.service\n';
      if (path.endsWith('/cgroup.events')) {
        const dir = path.slice(0, -'/cgroup.events'.length);
        if (!dirs.has(dir)) throw enoent(path);
        const list = pids.get(dir) ?? [];
        return `populated ${list.length > 0 ? 1 : 0}\nfrozen 0\n`;
      }
      if (path.endsWith('/cgroup.procs')) {
        const dir = path.slice(0, -'/cgroup.procs'.length);
        if (!dirs.has(dir)) throw enoent(path);
        return (pids.get(dir) ?? []).join('\n');
      }
      throw enoent(path);
    },
    writeFile: (path, data) => {
      const dir = path.replace(/\/cgroup\.(kill|procs)$/, '');
      if (!dirs.has(dir)) throw enoent(path);
      log.push(`write ${path} ${data}`);
      if (path.endsWith('/cgroup.kill')) {
        pids.set(dir, []);
      } else if (path.endsWith('/cgroup.procs')) {
        const moved = Number(data);
        for (const [key, list] of pids) {
          const filtered = list.filter(pid => pid !== moved);
          if (filtered.length !== list.length) pids.set(key, filtered);
        }
        pids.set(dir, [...(pids.get(dir) ?? []), moved]);
      }
    },
    mkdir: path => { dirs.add(path); log.push(`mkdir ${path}`); },
    rmdir: path => {
      if (!dirs.has(path)) throw enoent(path);
      if ((pids.get(path)?.length ?? 0) > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      dirs.delete(path);
      log.push(`rmdir ${path}`);
    },
    isDir: path => dirs.has(path),
    children: path => [...dirs].filter(dir => dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')),
  };
  return { fs, dirs, pids, log };
}

function fakeJobHelper() {
  const calls: string[][] = [];
  const keepers: Array<{ job: string; mode: string | undefined; ended: boolean }> = [];
  const helper: JobHelper = {
    keep: (job, mode) => {
      const entry = { job, mode, ended: false };
      keepers.push(entry);
      return Object.assign(new EventEmitter(), {
        stdin: { end: () => { entry.ended = true; } },
        exitCode: null,
        signalCode: null,
      }) as never;
    },
    call: args => {
      calls.push(args);
      if (args[0] === 'breakaway') return '43210';
      if (args[0] === 'terminate') return 'empty';
      return 'ok';
    },
  };
  return { helper, calls, keepers };
}

describe('session containment (hearsay-tools/squawk#1345)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    setSessionContainment(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('classifies normal exits vs abnormal exits accurately', () => {
    expect(isNormalSessionExit(0, null)).toBe(true);
    expect(isNormalSessionExit(1, null)).toBe(false);
    expect(isNormalSessionExit(null, 'SIGKILL')).toBe(false);
    expect(isNormalSessionExit(null, 'SIGTERM')).toBe(false);
    expect(isNormalSessionExit(null, 'SIGTERM', { gracefulEnd: true })).toBe(true);
    expect(isNormalSessionExit(143, null, { gracefulEnd: true })).toBe(true);
    expect(isNormalSessionExit(null, 'SIGSEGV', { gracefulEnd: true })).toBe(false);
    expect(isNormalSessionExit(null, 'SIGABRT', { gracefulEnd: true })).toBe(false);
    expect(isNormalSessionExit(1, null, { gracefulEnd: true })).toBe(false);
    expect(isNormalSessionExit(0, null, { forcedKill: true })).toBe(false);
    expect(isNormalSessionExit(null, 'SIGKILL', { gracefulEnd: true })).toBe(false);
    expect(isNormalSessionExit(null, 'SIGTERM', { gracefulEnd: true, forcedKill: true })).toBe(false);
  });

  it('executableReachable finds real executables, resolves relative/empty PATH entries against cwd, and rejects missing binaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-exec-check-'));
    dirs.push(dir);
    expect(executableReachable(process.execPath, dir, process.env)).toBe(true);
    expect(executableReachable(join(dir, 'missing-bin'), dir, process.env)).toBe(false);
    expect(executableReachable('definitely-no-such-squawk-binary-xyz', dir, process.env)).toBe(false);
    if (process.platform !== 'win32') {
      const plain = join(dir, 'not-exec');
      writeFileSync(plain, '#!/bin/sh\n');
      chmodSync(plain, 0o644);
      expect(executableReachable(plain, dir, process.env)).toBe(false);
      chmodSync(plain, 0o755);
      expect(executableReachable(plain, dir, process.env)).toBe(true);
      // Relative PATH segments (`.` / `./sub`) and empty segments (`:`) resolve against child cwd.
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      const localBin = join(dir, 'rel-tool');
      const subBin = join(sub, 'sub-tool');
      writeFileSync(localBin, '#!/bin/sh\n'); chmodSync(localBin, 0o755);
      writeFileSync(subBin, '#!/bin/sh\n'); chmodSync(subBin, 0o755);
      expect(executableReachable('rel-tool', dir, { PATH: '.' })).toBe(true);
      expect(executableReachable('rel-tool', dir, { PATH: `${delimiter}/usr/bin` })).toBe(true);
      expect(executableReachable('sub-tool', dir, { PATH: './sub' })).toBe(true);
    }
  });

  it('cgroup backend nests under parent cgroup, evacuates on normal exit, and reaps on abnormal exit', async () => {
    const base = '/sys/fs/cgroup/app.slice/squawk.service';
    const worker = `${base}/squawk-worker-w1`;
    const fake = fakeCgroupFs();
    setSessionContainment({ backend: 'cgroup', base });

    // Worker-nested session
    const nested = prepareSessionContainer(process.execPath, ['-v'], { cwd: process.cwd(), env: process.env, parentCgroup: worker, fs: fake.fs });
    expect(nested.file).toBe('/bin/sh');
    expect(nested.container?.kind).toBe('cgroup');
    if (nested.container?.kind !== 'cgroup') throw new Error('expected cgroup');
    expect(nested.container.path.startsWith(`${worker}/${SESSION_CGROUP_PREFIX}`)).toBe(true);
    expect(nested.container.parent).toBe(worker);

    // Normal exit evacuates detached PID up to worker cgroup without cgroup.kill
    fake.pids.set(nested.container.path, [90001]);
    releaseSessionContainer(nested.container);
    expect(fake.pids.get(worker)).toEqual([90001]);
    expect(fake.dirs.has(nested.container.path)).toBe(false);
    expect(fake.log.some(line => line.includes('cgroup.kill'))).toBe(false);

    // Abnormal exit sends SIGTERM, then cgroup.kill + rmdir after grace
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const crashed = prepareSessionContainer(process.execPath, ['-v'], { cwd: process.cwd(), env: process.env, fs: fake.fs });
    if (crashed.container?.kind !== 'cgroup') throw new Error('expected cgroup');
    const crashedPath = crashed.container.path;
    fake.pids.set(crashedPath, [90002]);
    reapSessionContainer(crashed.container, 100);
    expect(kill).toHaveBeenCalledWith(90002, 'SIGTERM');
    expect(fake.dirs.has(crashedPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.log.some(line => line === `write ${crashedPath}/cgroup.kill 1`)).toBe(true);
    expect(fake.dirs.has(crashedPath)).toBe(false);
  });

  it('cgroup backend skips wrapping for missing binaries and removes empty containers immediately', () => {
    const base = '/sys/fs/cgroup/app.slice/squawk.service';
    const fake = fakeCgroupFs();
    setSessionContainment({ backend: 'cgroup', base });

    const missing = prepareSessionContainer('/no/such/binary-xyz', ['--help'], { cwd: process.cwd(), env: process.env, fs: fake.fs });
    expect(missing).toEqual({ file: '/no/such/binary-xyz', argv: ['--help'], container: undefined });
    expect(fake.log).toEqual([]);

    const empty = prepareSessionContainer(process.execPath, ['-v'], { cwd: process.cwd(), env: process.env, fs: fake.fs });
    if (empty.container?.kind !== 'cgroup') throw new Error('expected cgroup');
    reapSessionContainer(empty.container, 10_000);
    expect(fake.dirs.has(empty.container.path)).toBe(false);
    expect(fake.log.some(line => line.includes('cgroup.kill'))).toBe(false);
  });

  it('non-contained host degrades quietly without creating any container', () => {
    setSessionContainment({ backend: 'none' });
    const plain = prepareSessionContainer(process.execPath, ['-v'], { cwd: process.cwd(), env: process.env });
    expect(plain).toEqual({ file: process.execPath, argv: ['-v'], container: undefined });
  });

  it('Windows job backend nests worker+session jobs, skips terminate on normal exit, and terminates on abnormal exit', () => {
    const jobs = fakeJobHelper();
    setSessionContainment({ backend: 'job' });

    const launched = prepareSessionContainer(process.execPath, ['-e', '1'], {
      cwd: process.cwd(),
      env: process.env,
      parentJob: 'Local\\squawk-worker-w1',
      helper: jobs.helper,
    });
    expect(launched.container?.kind).toBe('job');
    if (launched.container?.kind !== 'job') throw new Error('expected job');
    expect(launched.container.name.startsWith(SESSION_JOB_PREFIX)).toBe(true);
    expect(jobs.keepers[0]).toMatchObject({ job: launched.container.name, mode: 'keep-session', ended: false });
    expect(launched.argv.slice(-3, -1)).toEqual(['run', `Local\\squawk-worker-w1,${launched.container.name}`]);
    const argvFile = launched.argv.at(-1)!;
    expect(readFileSync(argvFile, 'utf8').split('\0')).toEqual([process.execPath, '-e', '1']);
    rmSync(argvFile, { force: true });

    // Normal exit closes keeper without terminateJob
    releaseSessionContainer(launched.container);
    expect(jobs.keepers[0]!.ended).toBe(true);
    expect(jobs.calls).toEqual([]);

    // Abnormal exit terminates the session job and closes keeper
    const crashed = prepareSessionContainer(process.execPath, ['-e', '1'], {
      cwd: process.cwd(),
      env: process.env,
      helper: jobs.helper,
    });
    if (crashed.container?.kind !== 'job') throw new Error('expected job');
    rmSync(crashed.argv.at(-1)!, { force: true });
    reapSessionContainer(crashed.container, 250);
    expect(jobs.calls).toContainEqual(['terminate', crashed.container.name, '250']);
    expect(jobs.keepers[1]!.ended).toBe(true);

    // Discard closes keeper without terminateJob
    const discarded = prepareSessionContainer(process.execPath, ['-e', '1'], {
      cwd: process.cwd(),
      env: process.env,
      helper: jobs.helper,
    });
    if (discarded.container?.kind !== 'job') throw new Error('expected job');
    rmSync(discarded.argv.at(-1)!, { force: true });
    discardSessionContainer(discarded.container);
    expect(jobs.keepers[2]!.ended).toBe(true);

    // Breakaway helper passes argv file and parses PID
    const pid = startBreakawayProcess('node.exe', ['job.js'], process.cwd(), process.env, jobs.helper);
    expect(pid).toBe(43210);
    const breakCall = jobs.calls.find(([op]) => op === 'breakaway')!;
    expect(readFileSync(breakCall[1]!, 'utf8').split('\0')).toEqual(['node.exe', 'job.js']);
    rmSync(breakCall[1]!, { force: true });
  });
});

// Native Windows Job Object verification (run by worker-scope-native.yml).
describe.runIf(process.platform === 'win32')('session containment on Windows', { timeout: 240_000 }, () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const exited = (child: { exitCode: number | null; signalCode: NodeJS.Signals | null; once: (ev: 'exit', cb: () => void) => unknown }) => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  beforeAll(() => {
    setSessionContainment(undefined);
    expect(probeJobs()).toEqual({ ok: true });
  }, 240_000);
  afterAll(async () => {
    await waitForSessionKeepers(15_000);
  }, 30_000);

  it('windows-native: abnormal exit ends a detached descendant while clean exit 0 keeps it alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-win-session-'));
    const crashPidFile = join(dir, 'crash.pid');
    const cleanPidFile = join(dir, 'clean.pid');
    let cleanPid = 0;
    try {
      const crashLeader = spawnSessionLeader(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 20000)'], { detached: true, stdio: 'ignore' });
        c.unref();
        fs.writeFileSync(${JSON.stringify(crashPidFile)}, String(c.pid));
        process.exit(1);
      `], { cwd: dir, env: process.env, timings: { killGraceMs: 2_000 } });
      await exited(crashLeader);
      // bound: PowerShell job wrapper startup and PID file write.
      await vi.waitFor(() => expect(existsSync(crashPidFile)).toBe(true), { timeout: 60_000 });
      const crashPid = Number(readFileSync(crashPidFile, 'utf8'));
      // bound: exit drain and TerminateJobObject after abnormal session exit.
      await vi.waitFor(() => expect(alive(crashPid)).toBe(false), { timeout: 60_000 });

      const cleanLeader = spawnSessionLeader(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 20000)'], { detached: true, stdio: 'ignore' });
        c.unref();
        fs.writeFileSync(${JSON.stringify(cleanPidFile)}, String(c.pid));
        process.exit(0);
      `], { cwd: dir, env: process.env, timings: { killGraceMs: 2_000 } });
      await exited(cleanLeader);
      // bound: PowerShell job wrapper startup and PID file write.
      await vi.waitFor(() => expect(existsSync(cleanPidFile)).toBe(true), { timeout: 60_000 });
      cleanPid = Number(readFileSync(cleanPidFile, 'utf8'));
      expect(alive(cleanPid)).toBe(true);
    } finally {
      if (cleanPid) {
        try { process.kill(cleanPid, 'SIGKILL'); } catch { /* gone */ }
        // bound: wait for Windows TerminateProcess to release cwd handle before rmSync.
        await vi.waitFor(() => expect(alive(cleanPid)).toBe(false), { timeout: 15_000 });
      }
      await waitForSessionKeepers(15_000);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('windows-native: nested worker+session job lets breakaway survive session crash and die on worker stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-win-nested-'));
    const mcpPidFile = join(dir, 'mcp.pid');
    const jobPidFile = join(dir, 'job.pid');
    const workerJob = `Local\\squawk-worker-${randomUUID()}`;
    const keeper = realJobHelper.keep(workerJob, 'keep');
    const osWinJobUrl = pathToFileURL(join(import.meta.dirname, 'os-win-job.ts')).href;
    const tsxUrl = import.meta.resolve('tsx');
    let jobPid = 0;
    try {
      const scope = {
        command: (file: string, args: readonly string[]): [string, string[]] => [file, [...args]],
        started: () => undefined,
        jobName: () => workerJob,
      };
      const leader = spawnSessionLeader(process.execPath, ['--import', tsxUrl, '--input-type=module', '-e', `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const { startBreakawayProcess } = await import(${JSON.stringify(osWinJobUrl)});
        const mcp = spawn(process.execPath, ['-e', 'setInterval(() => {}, 20000)'], { detached: true, stdio: 'ignore' });
        mcp.unref();
        writeFileSync(${JSON.stringify(mcpPidFile)}, String(mcp.pid));
        const bPid = startBreakawayProcess(process.execPath, ['-e', 'setInterval(() => {}, 20000)'], ${JSON.stringify(dir)}, process.env);
        writeFileSync(${JSON.stringify(jobPidFile)}, String(bPid));
        process.exit(1);
      `], { cwd: dir, env: process.env, timings: { killGraceMs: 2_000 }, scope });
      let stderr = '';
      leader.stderr.setEncoding('utf8');
      leader.stderr.on('data', (chunk: string) => { stderr += chunk; });
      await exited(leader);
      // bound: nested job startup and PID publication.
      await vi.waitFor(() => {
        expect(existsSync(mcpPidFile), `mcpPidFile missing; stderr: ${stderr}`).toBe(true);
        expect(existsSync(jobPidFile), `jobPidFile missing; stderr: ${stderr}`).toBe(true);
      }, { timeout: 60_000 });
      const mcpPid = Number(readFileSync(mcpPidFile, 'utf8'));
      jobPid = Number(readFileSync(jobPidFile, 'utf8'));
      // bound: session job TerminateJobObject after abnormal exit 1.
      await vi.waitFor(() => expect(alive(mcpPid)).toBe(false), { timeout: 60_000 });
      // Breakaway child escaped sessionJob into workerJob, so it survived the session crash.
      expect(alive(jobPid)).toBe(true);
      // Terminating the outer worker job kills the breakaway child too.
      expect(terminateJob(workerJob, 30_000)).toBe(true);
      // bound: asynchronous process exit after TerminateJobObject.
      await vi.waitFor(() => expect(alive(jobPid)).toBe(false), { timeout: 30_000 });
    } finally {
      try { terminateJob(workerJob, 5_000); } catch { /* gone */ }
      try { keeper.stdin?.end(); } catch { /* gone */ }
      await Promise.race([exited(keeper), new Promise(resolve => setTimeout(resolve, 15_000).unref?.())]);
      if (jobPid && alive(jobPid)) {
        try { process.kill(jobPid, 'SIGKILL'); } catch { /* gone */ }
        // bound: wait for Windows TerminateProcess to release cwd handle before rmSync.
        await vi.waitFor(() => expect(alive(jobPid)).toBe(false), { timeout: 15_000 });
      }
      await waitForSessionKeepers(15_000);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
