import { productIdentity } from '../../home/identity.ts';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { groupExists, groupRunning, processStartToken, startAndForget } from '../../detached-process.ts';
import { probeProcessWait } from '../../process-wait/supervisor.ts';
import { ignoreTermSource } from '../../stubborn-child.testkit.ts';
import { runJobCommand } from './cli.ts';
import { jobInstructions, ownCommand } from './command.ts';
import { randomUUID } from 'node:crypto';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { isSessionContained } from '../../core/session-containment.ts';
import { spawnSessionLeader } from '../../core/session-process.ts';
import { WorkerScopes, type ScopeStore } from '../../worker-scope/worker-scopes.ts';
import type { ScopeRecord } from '../../worker-scope/scope.ts';
import { claimJob, escapeSessionCgroup, jobPaths, jobRunsIn, jobStatus, startJob, stopJob, superviseJob } from './job.ts';

const run = promisify(execFile);
const dirs: string[] = [];
const pids: number[] = [];
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), 'cez-job-')); dirs.push(dir); return dir; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of pids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already ended */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Resolves once `path` exists: the supervisor renames its exit file into place when the job ends. */
async function written(path: string): Promise<void> {
  await vi.waitFor(() => { if (!existsSync(path)) throw new Error(`${path} is not written yet`); }, { timeout: 20_000, interval: 25 }); // bound: hang guard; the exit file is the job's own end signal
}

const posix = process.platform !== 'win32';
// The command exactly as the launch prompt gives it to the agent.
const startCommand = /start it with (.+ job start) <name>/.exec(jobInstructions())![1]!;
it('the launch prompt names stop for ending a job, never kill <pid>', () => {
  expect(jobInstructions()).toContain('or with `stop` to end it and every process it started; never `kill` its `pid`');
});
const node = (script: string) => [process.execPath, '-e', script];

it.runIf(posix)('a job started by a CLI process that has ended reports its real exit code to a process wait', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const script = `const fs=require('fs');console.log('out');console.error('err');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.exit(7)}},20)`;
  // The starting process is a real CLI process, and `execFile` resolves only after it has ended.
  const { stdout } = await run('sh', ['-c', `${startCommand} build --dir "$1" -- "$2" -e "$3"`, 'sh', dir, process.execPath, script]);
  const started = JSON.parse(stdout) as { name: string; pid: number; log: string; exitFile: string; replaced: boolean };
  pids.push(started.pid);
  expect(started).toMatchObject({ name: 'build', replaced: false });
  expect([started.log, started.exitFile]).toEqual([expect.stringMatching(/build\.[0-9a-z]+-\d+\.log$/), expect.stringMatching(/build\.[0-9a-z]+-\d+\.exit$/)]);
  expect(started.log.startsWith(dir) && started.exitFile.startsWith(dir)).toBe(true);
  // The supervisor leads its own session, which is what outlives a runner's group cleanup.
  const { stdout: ids } = await run('ps', ['-o', 'sid=,pgid=', '-p', String(started.pid)]);
  expect(ids.trim().split(/\s+/).map(Number)).toEqual([started.pid, started.pid]);
  const roots = { worktree: dir };
  const request = { pid: started.pid, exitFile: started.exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots };
  expect(probeProcessWait(request, Date.now())).toBeUndefined();
  expect(jobStatus(dir, 'build')).toMatchObject({ state: 'running', pid: started.pid });
  writeFileSync(gate, '');
  await written(started.exitFile);
  expect(probeProcessWait(request, Date.now())).toMatchObject({ outcome: 'exit_file', exitCode: 7 });
  expect(readFileSync(started.log, 'utf8')).toBe('out\nerr\n');
  expect(jobStatus(dir, 'build')).toMatchObject({ state: 'exited', exitCode: 7 });
}, 30_000);

it.runIf(posix)('a second start of a running name refuses and names its PID; a name that ended starts again', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const first = await startJob({ name: 'bench', dir, command: node(`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},20)`) });
  pids.push(first.pid);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runJobCommand(['start', 'bench', '--dir', dir, '--', ...node('')], {})).toBe(1);
  expect(JSON.parse(String(error.mock.calls[0]?.[0])).error).toContain(`already running as PID ${first.pid}`);
  writeFileSync(gate, '');
  await written(first.exitFile);
  const second = await startJob({ name: 'bench', dir, command: node('process.exit(3)') });
  pids.push(second.pid);
  expect(second).toMatchObject({ replaced: true });
  expect(second.pid).not.toBe(first.pid);
  await written(second.exitFile);
  // A process wait still open on the first start reads the first start's code, never the second's.
  expect(second.exitFile).not.toBe(first.exitFile);
  const firstWait = { pid: first.pid, exitFile: first.exitFile, deadline: new Date(Date.now() + 60_000).toISOString(), roots: { worktree: dir } };
  expect(probeProcessWait(firstWait, Date.now())).toMatchObject({ outcome: 'exit_file', exitCode: 0 });
  expect(jobStatus(dir, 'bench')).toMatchObject({ state: 'exited', exitCode: 3, pid: second.pid });
}, 30_000);

it.runIf(posix)('a command that cannot run exits 127 with the reason in the log', async () => {
  const dir = scratch();
  const job = await startJob({ name: 'missing', dir, command: [join(dir, 'no-such-binary')] });
  pids.push(job.pid);
  await written(job.exitFile);
  expect(jobStatus(dir, 'missing')).toMatchObject({ state: 'exited', exitCode: 127 });
  expect(readFileSync(job.log, 'utf8')).toContain('cannot run');
}, 30_000);

it('the supervisor records itself, writes the output and the exit code, and leaves no signal handler', async () => {
  const dir = scratch();
  const before = process.listenerCount('SIGTERM');
  expect(await superviseJob(dir, 'inline', node("console.log('ran');process.exit(4)"))).toBe(4);
  const inline = jobStatus(dir, 'inline');
  expect(readFileSync(inline.log, 'utf8')).toBe('ran\n');
  expect(readFileSync(inline.exitFile, 'utf8')).toBe('4\n');
  expect(process.listenerCount('SIGTERM')).toBe(before);
  // The record names this live process, so only the exit file says the job ended.
  expect(jobStatus(dir, 'inline')).toMatchObject({ state: 'exited', exitCode: 4 });
  expect(await superviseJob(dir, 'killed', node("process.kill(process.pid,'SIGKILL')"))).toBe(137);
  expect(await superviseJob(dir, 'absent', [join(dir, 'no-such-binary')])).toBe(127);
  // Deleting a task's history removes its temp directory: the supervisor still ends with the code.
  const gone = join(dir, 'gone');
  mkdirSync(gone);
  expect(await superviseJob(gone, 'late', node(`require('fs').rmSync(${JSON.stringify(gone)},{recursive:true});process.exit(2)`))).toBe(2);
  expect(existsSync(gone)).toBe(false);
});

let runs = 0;
const files = (dir: string, name: string) => { runs += 1; return { log: join(dir, `${name}.${runs}.log`), exitFile: join(dir, `${name}.${runs}.exit`) }; };
const dead = (dir: string, name: string) => ({ name, pid: 2 ** 22 + 7, start: 'boot:1', command: ['x'], startedAt: new Date().toISOString(), ...files(dir, name) });
const self = (dir: string, name: string) => ({ name, pid: process.pid, start: processStartToken(process.pid)!, command: ['x'], startedAt: new Date().toISOString(), ...files(dir, name) });

it('status reads a record whose supervisor is gone and left no exit file as exited without a code', () => {
  const dir = scratch();
  expect(claimJob(jobPaths(dir, 'lost'), dead(dir, 'lost'))).toMatchObject({ claimed: true, replaced: false });
  const status = jobStatus(dir, 'lost');
  expect(status).toMatchObject({ state: 'exited' });
  expect(status).not.toHaveProperty('exitCode');
});

it.runIf(posix)('a directory holds a running job while a record names a live supervisor with no exit code, or cannot be read', () => {
  const [empty, ended, live, damaged] = [scratch(), scratch(), scratch(), scratch()];
  writeFileSync(join(empty, 'notes.db'), 'not a record');
  expect(jobRunsIn([empty, join(empty, 'absent')])).toBe(false);
  claimJob(jobPaths(ended, 'gone'), dead(ended, 'gone'));
  const finished = self(ended, 'done');
  claimJob(jobPaths(ended, 'done'), finished);
  writeFileSync(finished.exitFile, '0\n');
  expect(jobRunsIn([ended])).toBe(false);
  claimJob(jobPaths(live, 'bench'), self(live, 'bench'));
  expect(jobRunsIn([ended, live])).toBe(true);
  // It may belong to a supervisor that still runs.
  writeFileSync(join(damaged, 'bench.job.db'), 'damaged');
  expect(jobRunsIn([damaged])).toBe(true);
});

it.runIf(posix)('a claim is refused while the holder runs, and taken from a holder that is gone or has written its exit file', () => {
  const dir = scratch();
  const paths = jobPaths(dir, 'claim');
  const holder = self(dir, 'claim');
  expect(claimJob(paths, holder)).toEqual({ claimed: true, replaced: false, log: holder.log, exitFile: holder.exitFile });
  expect(claimJob(paths, dead(dir, 'claim'))).toEqual({ claimed: false, pid: process.pid });
  expect(jobStatus(dir, 'claim')).toMatchObject({ state: 'running', pid: process.pid, exitFile: holder.exitFile });
  // The holder wrote its exit file: it is done, though its process still ends.
  writeFileSync(holder.exitFile, '0\n');
  expect(claimJob(paths, dead(dir, 'claim'))).toMatchObject({ claimed: true, replaced: true });
  // The earlier start's exit file stays for a wait that still reads it.
  expect(readFileSync(holder.exitFile, 'utf8')).toBe('0\n');
  expect(claimJob(paths, self(dir, 'claim'))).toMatchObject({ claimed: true, replaced: true });
});

it.runIf(posix)('of several starts of one name at once, exactly one runs the command', async () => {
  const dir = scratch();
  const gate = join(dir, 'gate');
  const marks = join(dir, 'marks');
  const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marks)},'x');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},20)`;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => startJob({ name: 'race', dir, command: node(script) })));
  const started = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  for (const job of started) pids.push(job.pid);
  expect(started).toHaveLength(1);
  const refusals = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
  expect(refusals).toEqual(Array.from({ length: 3 }, () => expect.stringContaining(`already running as PID ${started[0]!.pid}`)));
  writeFileSync(gate, '');
  await written(started[0]!.exitFile);
  expect(readFileSync(marks, 'utf8')).toBe('x');
}, 60_000);

it.runIf(posix)('a supervisor whose starter has ended still claims the name and runs the command', async () => {
  const dir = scratch();
  // No channel to a starter: the supervisor has no one to tell.
  const [bin, ...prefix] = ownCommand();
  expect(await startAndForget(bin!, [...prefix, 'job', '__supervise', dir, 'orphan', '--', ...node('process.exit(8)')], { settleMs: 0 })).toBe(true);
  await vi.waitFor(() => { expect(jobStatus(dir, 'orphan')).toMatchObject({ state: 'exited', exitCode: 8 }); }, { timeout: 20_000, interval: 25 }); // bound: hang guard; the supervisor's own record and exit file are the signal
  pids.push(jobStatus(dir, 'orphan').pid);
}, 30_000);

it.runIf(posix)('a record file that is not a record never counts as absent: start and status refuse, and nothing is replaced', async () => {
  const dir = scratch();
  const paths = jobPaths(dir, 'damaged');
  const earlier = join(dir, 'damaged.1-1.log');
  writeFileSync(earlier, 'earlier output\n');
  writeFileSync(paths.record, 'this is not a database, and it is long enough to be read as one: '.repeat(4));
  await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('cannot be used');
  expect(() => jobStatus(dir, 'damaged')).toThrow('cannot be used');
  rmSync(paths.record);
  const db = new DatabaseSync(paths.record);
  db.exec("CREATE TABLE job (id INTEGER PRIMARY KEY, record TEXT NOT NULL); INSERT INTO job VALUES (1, '{\"pid\":\"12\"}')");
  db.close();
  await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('it holds no job record');
  expect(() => jobStatus(dir, 'damaged')).toThrow('it holds no job record');
  // Another program's database, and a job table that lost its row, are not a free name either.
  for (const schema of ['CREATE TABLE other (x)', 'CREATE TABLE job (id INTEGER PRIMARY KEY, record TEXT NOT NULL)']) {
    rmSync(paths.record);
    const other = new DatabaseSync(paths.record);
    other.exec(schema);
    other.close();
    await expect(startJob({ name: 'damaged', dir, command: node('') })).rejects.toThrow('cannot be used');
    expect(() => jobStatus(dir, 'damaged')).toThrow('cannot be used');
  }
  expect(readFileSync(earlier, 'utf8')).toBe('earlier output\n');
  // A claimant that ended before its first commit leaves an empty file: that is a free name.
  writeFileSync(paths.record, '');
  expect(() => jobStatus(dir, 'damaged')).toThrow('No job named "damaged"');
  const job = await startJob({ name: 'damaged', dir, command: node('') });
  pids.push(job.pid);
  await written(job.exitFile);
}, 30_000);

it('answers usage errors as JSON on stderr with exit 1, and help with exit 0', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = scratch();
  expect(await runJobCommand(['start', 'no-command', '--dir', dir], {})).toBe(1);
  expect(await runJobCommand(['start', '../escape', '--dir', dir, '--', 'true'], {})).toBe(1);
  expect(await runJobCommand(['status', 'absent', '--dir', dir], {})).toBe(1);
  expect(await runJobCommand(['kill', 'x'], {})).toBe(1);
  expect(error.mock.calls.map(call => JSON.parse(String(call[0])).error)).toEqual([
    expect.stringContaining('after "--"'), expect.stringContaining('Invalid job name'), expect.stringContaining('No job named "absent"'), expect.stringContaining(`Usage: ${productIdentity().command} job start`),
  ]);
  expect(await runJobCommand(['--help'], {})).toBe(0);
  expect(log.mock.calls[0]?.[0]).toContain(`${productIdentity().command} job status`);
  // A `--help` after `--` belongs to the command, not to `cez job`.
  expect(await runJobCommand(['status', 'absent', '--dir', dir, '--', '--help'], {})).toBe(1);
});

/** A job whose command starts a grandchild that ignores SIGTERM, as a test runner's workers or a
 *  fixture can; resolves once the grandchild has set its handler and written its pid. */
async function stubbornJob(dir: string, name: string): Promise<{ pid: number; exitFile: string; grandchild: number }> {
  const marker = join(dir, `${name}.grandchild`);
  const grandchild = `${ignoreTermSource()} require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const job = await startJob({ name, dir, command: ['sh', '-c', '"$0" -e "$1" & wait', process.execPath, grandchild] });
  pids.push(job.pid);
  await written(marker);
  return { pid: job.pid, exitFile: job.exitFile, grandchild: Number(readFileSync(marker, 'utf8')) };
}

const leaderOf = (pid: number) => ({ pid, start: processStartToken(pid) });

it.runIf(posix)('stop ends the whole group of a running job, a grandchild that ignores SIGTERM included', async () => {
  const dir = scratch();
  const job = await stubbornJob(dir, 'suite');
  const leader = leaderOf(job.pid);
  expect(await stopJob(dir, 'suite', { graceMs: 300 })).toEqual({ name: 'suite', pid: job.pid, stopped: true });
  expect(groupRunning(leader)).toBe(false);
}, 30_000);

it.runIf(process.platform === 'linux')('stop ends what a job left in its group after its supervisor was killed by PID', async () => {
  const dir = scratch();
  const job = await stubbornJob(dir, 'bench');
  const leader = leaderOf(job.pid);
  process.kill(job.pid, 'SIGTERM');
  await written(job.exitFile);
  // What `kill <pid>` leaves: the job reads as exited while its grandchild still runs.
  expect(jobStatus(dir, 'bench')).toMatchObject({ state: 'exited' });
  expect(groupRunning(leader)).toBe(true);
  expect(await stopJob(dir, 'bench', { graceMs: 300 })).toEqual({ name: 'bench', pid: job.pid, stopped: true });
  expect(groupRunning(leader)).toBe(false);
}, 30_000);

it.runIf(posix)('stop of a job whose group has ended signals nothing and reports it stopped; an unknown name refuses', async () => {
  const dir = scratch();
  const job = await startJob({ name: 'done', dir, command: node('') });
  pids.push(job.pid);
  await written(job.exitFile);
  // Gone, not only stopped running: a group of unreaped zombies still exists, and stop signals it.
  await vi.waitFor(() => { if (groupExists(leaderOf(job.pid))) throw new Error('the group still exists'); }, { timeout: 20_000, interval: 25 }); // bound: hang guard; the group ends once its last member is reaped
  const kill = vi.spyOn(process, 'kill');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runJobCommand(['stop', 'done', '--dir', dir], {})).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ name: 'done', pid: job.pid, stopped: true });
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
  expect(await runJobCommand(['stop', 'absent', '--dir', dir], {})).toBe(1);
  expect(JSON.parse(String(error.mock.calls[0]?.[0])).error).toContain('No job named "absent"');
}, 30_000);

it.runIf(process.platform === 'linux')('stop never signals a leaderless group the record cannot prove is the job\'s, such as one from another boot', async () => {
  const dir = scratch();
  // A group whose leader has exited while a member runs: what a reused number can name after a reboot.
  const leader = spawn('sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'ignore' });
  pids.push(leader.pid!);
  await new Promise(done => leader.once('exit', done));
  expect(groupRunning({ pid: leader.pid! })).toBe(true);
  const otherBoot = '00000000-0000-4000-8000-000000000000:1';
  claimJob(jobPaths(dir, 'old'), { name: 'old', pid: leader.pid!, start: otherBoot, command: ['true'], startedAt: new Date().toISOString(), log: join(dir, 'old.log'), exitFile: join(dir, 'old.exit') });
  const kill = vi.spyOn(process, 'kill');
  // The recorded boot has ended, so every group of the job ended with it.
  expect(await stopJob(dir, 'old', { graceMs: 300 })).toEqual({ name: 'old', pid: leader.pid, stopped: true });
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
  expect(groupRunning({ pid: leader.pid! })).toBe(true);
});

it.runIf(process.platform === 'darwin')('on macOS, stop reports a group its supervisor left and never signals it: no boot id proves it is the job\'s', async () => {
  const dir = scratch();
  const job = await stubbornJob(dir, 'left');
  process.kill(job.pid, 'SIGTERM');
  await written(job.exitFile);
  await vi.waitFor(() => { try { process.kill(job.pid, 0); } catch { return; } throw new Error('the supervisor still runs'); }, { timeout: 20_000, interval: 25 }); // bound: hang guard; the supervisor exits after its exit file
  const kill = vi.spyOn(process, 'kill');
  expect(await stopJob(dir, 'left', { graceMs: 300 })).toEqual({ name: 'left', pid: job.pid, stopped: false });
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
}, 30_000);

it('escapeSessionCgroup moves out of squawk-session-* cgroups and stops at the worker or base cgroup', () => {
  const base = '/sys/fs/cgroup/app.slice/squawk.service';
  let current: string | undefined = `${base}/squawk-worker-w1/squawk-session-a/squawk-session-b`;
  const writes: Array<[string, string]> = [];
  escapeSessionCgroup(
    () => current,
    (path, pid) => {
      writes.push([path, pid]);
      current = path.slice(0, -'/cgroup.procs'.length);
    },
  );
  expect(writes).toEqual([
    [`${base}/squawk-worker-w1/squawk-session-a/cgroup.procs`, '0'],
    [`${base}/squawk-worker-w1/cgroup.procs`, '0'],
  ]);
  expect(current).toBe(`${base}/squawk-worker-w1`);

  // Outside a session cgroup: no-op
  const noopWrites: Array<[string, string]> = [];
  escapeSessionCgroup(() => `${base}/squawk-worker-w1`, (p, v) => noopWrites.push([p, v]));
  expect(noopWrites).toEqual([]);
});

it.runIf(process.platform === 'linux' && isSessionContained())('a job started inside a worker session survives session SIGKILL while detached leftovers die, and ends on worker destroy (hearsay-tools/squawk#1345)', async () => {
  const dir = scratch();
  const workerId = randomUUID();
  let scopeRecord: ScopeRecord | undefined;
  const store: ScopeStore = {
    readWorkerScope: () => scopeRecord ?? 'absent',
    writeWorkerScope: (_id, next) => { scopeRecord = next; },
    getRun: id => ({ id, delegation: { role: 'worker' } }) as unknown as RunRecord,
    readWorkerExecution: () => undefined,
    readWorkerProcesses: () => 'absent',
  };
  const scopes = new WorkerScopes(store);
  const scope = scopes.spawnScope(workerId);

  const [jobBin, ...jobPrefix] = ownCommand();
  const mcpPidFile = join(dir, 'mcp.pid');
  const jobJsonFile = join(dir, 'job.json');
  const leaderScript = `
    const { spawn, execFileSync } = require('child_process');
    const fs = require('fs');
    const mcp = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignoreTermSource()} setInterval(() => {}, 20000);`)}], { detached: true, stdio: 'ignore' });
    mcp.unref();
    fs.writeFileSync(${JSON.stringify(mcpPidFile)} + '.tmp', String(mcp.pid));
    fs.renameSync(${JSON.stringify(mcpPidFile)} + '.tmp', ${JSON.stringify(mcpPidFile)});
    const out = execFileSync(${JSON.stringify(jobBin)}, ${JSON.stringify([...jobPrefix, 'job', 'start', 'survivor', '--dir', dir, '--', process.execPath, '-e', 'setInterval(() => {}, 20000)'])} , { encoding: 'utf8' });
    fs.writeFileSync(${JSON.stringify(jobJsonFile)} + '.tmp', out);
    fs.renameSync(${JSON.stringify(jobJsonFile)} + '.tmp', ${JSON.stringify(jobJsonFile)});
    setInterval(() => {}, 20000);
  `;
  const leader = spawnSessionLeader(process.execPath, ['-e', leaderScript], {
    cwd: dir, env: process.env, timings: { killGraceMs: 100 }, scope,
  });
  pids.push(leader.pid!);
  try {
    // bound: wait for the session to spawn both the detached MCP stub and the hsq job.
    await vi.waitFor(() => {
      expect(existsSync(mcpPidFile)).toBe(true);
      expect(existsSync(jobJsonFile)).toBe(true);
    }, { timeout: 20_000, interval: 25 });
    const mcpPid = Number(readFileSync(mcpPidFile, 'utf8'));
    const job = JSON.parse(readFileSync(jobJsonFile, 'utf8')) as { pid: number; exitFile: string };
    pids.push(mcpPid, job.pid);

    // Crash the session leader with SIGKILL.
    leader.kill('SIGKILL');
    await new Promise<void>(resolve => { if (leader.exitCode !== null || leader.signalCode !== null) resolve(); else leader.once('exit', () => resolve()); });

    // Detached MCP stub inside the crashed session must die.
    // bound: exit drain, SIGTERM grace, cgroup.kill and reaping.
    await vi.waitFor(() => {
      try { process.kill(mcpPid, 0); throw new Error('still alive'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }, { timeout: 10_000, interval: 25 });

    // The hsq job escaped the session cgroup into the worker cgroup, so it survives the session crash.
    expect(jobStatus(dir, 'survivor')).toMatchObject({ state: 'running', pid: job.pid });

    // Destroying the worker still ends the escaped job because it remained in the worker's cgroup.
    expect(await scopes.stop(workerId, 10_000)).toEqual({ stopped: true });
    // bound: hang guard; worker cgroup.kill already completed
    await vi.waitFor(() => {
      try { process.kill(job.pid, 0); throw new Error('still alive'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }, { timeout: 10_000, interval: 25 });
  } finally {
    await scopes.stop(workerId, 5_000);
  }
}, 40_000);
