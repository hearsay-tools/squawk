import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { ScopeRecord } from './scope.ts';
import { WorkerScopes, type ScopeStore } from './worker-scopes.ts';

// A group of zombies under an init that never reaps: `kill(-pgid, 0)` keeps succeeding, and no
// member runs. Both answers are pinned, as such an init would leave them.
const signalled = vi.hoisted(() => [] as Array<[number, string]>);
const members = vi.hoisted(() => ({ running: false }));
vi.mock('../core/session-process.ts', () => ({
  processGroupAlive: () => true,
  processGroupRunning: () => members.running,
  signalProcessGroup: (pgid: number, signal: string) => { signalled.push([pgid, signal]); },
}));
vi.mock('../core/process-stat.ts', async original => ({
  ...await original<typeof import('../core/process-stat.ts')>(),
  linuxBootId: () => '11111111-1111-4111-8111-111111111111',
  pidExists: () => false,
}));

describe.runIf(process.platform === 'linux')('a zombie-only group (hearsay-tools/squawk#3698 review)', () => {
  it('stop kills it once and does not wait for it; a scope never stopped still counts it as running', async () => {
    const workerId = randomUUID();
    const group = { pid: 4242, pgid: 4242, startToken: '11111111-1111-4111-8111-111111111111:100' };
    let record: ScopeRecord = { workerId, cgroups: [], jobs: [], groups: [group] };
    const store: ScopeStore = {
      readWorkerScope: () => record, writeWorkerScope: (_id, next) => { record = next; },
      getRun: id => ({ id, delegation: { role: 'worker' } }) as unknown as RunRecord,
      readWorkerExecution: () => undefined, readWorkerProcesses: () => 'absent',
    };
    const scopes = new WorkerScopes(store, () => ({ backend: 'groups', reason: 'test' }));
    expect(scopes.empty(workerId)).toBe(false);
    const started = Date.now();
    expect(await scopes.stop(workerId, 5_000)).toEqual({ stopped: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signalled).toEqual([[4242, 'SIGKILL']]);
    expect(record.groups).toEqual([]);
    record = { workerId, cgroups: [], jobs: [], groups: [group] };
    scopes.kill(workerId);
    expect(scopes.stopped(workerId)).toBe(true);
  });

  it('a leaderless group with a member still exiting is waited for, and stays recorded', async () => {
    const workerId = randomUUID();
    const group = { pid: 4343, pgid: 4343, startToken: '11111111-1111-4111-8111-111111111111:100' };
    let record: ScopeRecord = { workerId, cgroups: [], jobs: [], groups: [group] };
    const store: ScopeStore = {
      readWorkerScope: () => record, writeWorkerScope: (_id, next) => { record = next; },
      getRun: id => ({ id, delegation: { role: 'worker' } }) as unknown as RunRecord,
      readWorkerExecution: () => undefined, readWorkerProcesses: () => 'absent',
    };
    const scopes = new WorkerScopes(store, () => ({ backend: 'groups', reason: 'test' }));
    members.running = true;
    try {
      scopes.kill(workerId);
      expect(scopes.stopped(workerId)).toBe(false);
      expect(await scopes.stop(workerId, 50)).toMatchObject({ stopped: false });
      expect(record.groups).toEqual([group]);
    } finally { members.running = false; }
  });
});
