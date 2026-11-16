import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pidExists, processStartToken, type RecordedProcess } from '../core/process-stat.ts';
import { probeCgroups } from './cgroup.ts';
import { SCOPE_GROUP_CAP, type ScopeRecord } from './scope.ts';
import * as groupsModule from './groups.ts';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { WorkerScopes, type HostScope, type ScopeStore } from './worker-scopes.ts';

/** bound: a SIGKILLed process is reaped by its parent within milliseconds; this only ends a hang. */
const HANG_GUARD_MS = 10_000;
const posix = process.platform !== 'win32';
const cgroupHost = process.platform === 'linux' ? probeCgroups() : { reason: 'not linux' };

function memoryStore(init: Partial<{ record: ScopeRecord | 'unknown'; legacy: RecordedProcess[]; destroying: boolean }> = {}) {
  const state = { record: init.record as ScopeRecord | 'unknown' | undefined, legacy: init.legacy ?? [], destroying: init.destroying ?? false };
  const store: ScopeStore = {
    readWorkerScope: () => state.record ?? 'absent',
    writeWorkerScope: (_id, record) => { state.record = record; },
    getRun: id => ({ id, delegation: { role: 'worker', ...(state.destroying ? { destroy: {} } : {}) } }) as unknown as RunRecord,
    readWorkerExecution: () => ({ generation: 'g' }),
    readWorkerProcesses: () => ({ generation: 'g', controller: { pid: 1 }, processes: state.legacy }),
  };
  return { store, state };
}

const started: number[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of started.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

/** Runs `script` through the scope as a detached group leader; returns the leader and the pid it printed. */
async function launch(scopes: WorkerScopes, workerId: string, script: string): Promise<{ leader: number; printed: number }> {
  const scope = scopes.spawnScope(workerId);
  const [file, args] = scope.command('/bin/sh', ['-c', script]);
  const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  scope.started(child.pid!);
  started.push(child.pid!);
  const printed = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())));
    child.once('error', reject);
  });
  started.push(printed);
  return { leader: child.pid!, printed };
}

describe('WorkerScopes', () => {
  it('starts nothing once destroy has begun, and fails closed on an unreadable record', async () => {
    const groups: HostScope = { backend: 'groups', reason: 'test' };
    expect(() => new WorkerScopes(memoryStore({ destroying: true }).store, () => groups).spawnScope('w').command('a', [])).toThrow(/destruction has begun/);
    const unreadable = new WorkerScopes(memoryStore({ record: 'unknown' }).store, () => groups);
    expect(() => unreadable.spawnScope('w').started(123)).toThrow(/unreadable/);
    expect(await unreadable.stop('w', 100)).toEqual({ stopped: false, error: expect.stringMatching(/unreadable/) });
  });

  it('describes the host guarantee', () => {
    expect(new WorkerScopes(memoryStore().store, () => ({ backend: 'groups', reason: 'x' })).describe()).toEqual({ backend: 'groups', guarantee: 'scoped' });
    expect(new WorkerScopes(memoryStore().store, () => ({ backend: 'cgroup', base: '/sys/fs/cgroup/x' })).describe()).toEqual({ backend: 'cgroup', guarantee: 'contained' });
  });

  it.runIf(posix)('groups: records each started group and stop ends its leader and members', async () => {
    const workerId = randomUUID();
    const { store, state } = memoryStore();
    const scopes = new WorkerScopes(store, () => ({ backend: 'groups', reason: 'test' }));
    // The leader prints a background child's pid and stays; the child is in the leader's group.
    const { leader, printed } = await launch(scopes, workerId, 'sleep 30 & echo $!; wait');
    expect(state.record).toMatchObject({ workerId, cgroups: [], groups: [{ pid: leader, pgid: leader }] });
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(printed)).toBe(false);
    expect(pidExists(leader)).toBe(false);
    expect(state.record).toEqual({ workerId, cgroups: [], groups: [] });
  });

  it.runIf(process.platform === 'linux')('groups: a leaderless group counts only with a token from this boot', async () => {
    const workerId = randomUUID();
    const { store, state } = memoryStore();
    const scopes = new WorkerScopes(store, () => ({ backend: 'groups', reason: 'test' }));
    const { leader, printed } = await launch(scopes, workerId, 'sleep 30 & echo $!');
    await vi.waitFor(() => expect(pidExists(leader)).toBe(false), { timeout: HANG_GUARD_MS });
    const record = state.record as ScopeRecord;
    // The same group recorded at another boot proves nothing: never signalled.
    state.record = { ...record, groups: record.groups.map(group => ({ ...group, startToken: `00000000-0000-4000-8000-000000000000:${group.startToken!.split(':')[1]}` })) };
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(printed)).toBe(true);
    // Recorded at this boot: the member is ended, and stop returns only once it has exited.
    state.record = record;
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(printed)).toBe(false);
  });

  it.runIf(posix)('groups: refuses a start past the cap instead of forgetting a live group', async () => {
    const workerId = randomUUID();
    const { store, state } = memoryStore();
    const scopes = new WorkerScopes(store, () => ({ backend: 'groups', reason: 'test' }));
    const live = { pid: process.pid, pgid: process.pid, startToken: 'live' };
    state.record = { workerId, cgroups: [], groups: Array.from({ length: SCOPE_GROUP_CAP }, () => live) };
    vi.spyOn(groupsModule, 'liveGroups').mockImplementation(entries => [...entries]);
    // Refused before the command runs, and again if a start races past that check.
    expect(() => scopes.spawnScope(workerId).command('true', [])).toThrow(/already owns/);
    expect(() => scopes.spawnScope(workerId).started(process.pid)).toThrow(/already owns/);
    expect((state.record as ScopeRecord).groups).toHaveLength(SCOPE_GROUP_CAP);
  });

  it.runIf(posix)('groups: a descendant that left the group survives stop (the documented limit)', async () => {
    const workerId = randomUUID();
    const scopes = new WorkerScopes(memoryStore().store, () => ({ backend: 'groups', reason: 'test' }));
    const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0;
    if (!hasSetsid) return;
    // The pid is printed from inside the new session, so stop cannot run before the escape.
    const { printed } = await launch(scopes, workerId, "setsid sh -c 'echo $$; exec sleep 30' &");
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(printed)).toBe(true);
  });

  it.runIf(posix)('groups: a worker from before scopes is stopped through its execution record', async () => {
    const workerId = randomUUID();
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    started.push(child.pid!);
    const token = processStartToken(child.pid!);
    const legacy = [{ pid: child.pid!, pgid: child.pid!, ...(token ? { startToken: token } : {}) }];
    const scopes = new WorkerScopes(memoryStore({ legacy }).store, () => ({ backend: 'groups', reason: 'test' }));
    const exited = new Promise(resolve => child.once('exit', resolve));
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    await exited;
  });

  it.runIf('base' in cgroupHost)('cgroup: stop ends a detached descendant after its leader exited, and removes the cgroup', async () => {
    const base = (cgroupHost as { base: string }).base;
    const workerId = randomUUID();
    const { store, state } = memoryStore();
    const scopes = new WorkerScopes(store, () => ({ backend: 'cgroup', base }));
    const { leader, printed } = await launch(scopes, workerId, "setsid sh -c 'echo $$; exec sleep 30' &");
    const path = `${base}/squawk-worker-${workerId}`;
    expect(state.record).toEqual({ workerId, cgroups: [path], groups: [] });
    expect(readFileSync(`/proc/${printed}/cgroup`, 'utf8')).toContain(`/squawk-worker-${workerId}`);
    await vi.waitFor(() => expect(pidExists(leader)).toBe(false), { timeout: HANG_GUARD_MS });
    expect(pidExists(printed)).toBe(true);
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(printed)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(state.record).toEqual({ workerId, cgroups: [], groups: [] });
  });

  it.runIf('base' in cgroupHost)('cgroup: a command whose move fails never runs', async () => {
    const base = (cgroupHost as { base: string }).base;
    const workerId = randomUUID();
    const scopes = new WorkerScopes(memoryStore().store, () => ({ backend: 'cgroup', base }));
    const marker = join(mkdtempSync(join(tmpdir(), 'cez-scope-')), 'ran');
    const [file, args] = scopes.spawnScope(workerId).command('/bin/sh', ['-c', `touch ${marker}`]);
    // The cgroup vanished between the record and the start (a racing destroy removed it).
    rmdirSync(`${base}/squawk-worker-${workerId}`);
    const result = spawnSync(file, args, { stdio: 'ignore' });
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf('base' in cgroupHost)('cgroup: kill ends the scope now and leaves it usable for the next start', async () => {
    const base = (cgroupHost as { base: string }).base;
    const workerId = randomUUID();
    const scopes = new WorkerScopes(memoryStore().store, () => ({ backend: 'cgroup', base }));
    const first = await launch(scopes, workerId, 'sleep 30 & echo $!');
    scopes.kill(workerId);
    await vi.waitFor(() => expect(pidExists(first.printed)).toBe(false), { timeout: HANG_GUARD_MS });
    const second = await launch(scopes, workerId, 'sleep 30 & echo $!');
    expect(pidExists(second.printed)).toBe(true);
    expect(await scopes.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(second.printed)).toBe(false);
  });
});
