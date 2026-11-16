import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { pidExists } from '../core/process-stat.ts';
import type { ScopeRecord } from './scope.ts';
import { WorkerScopes, type ScopeStore } from './worker-scopes.ts';

// macOS has no cgroups and no boot id in a start token, so it always runs the `groups` backend with
// its accepted limit (ADR 0032, owner decision 2026-10-29): registered services and the worker's own
// groups stop; a descendant that left them survives.
/** bound: a SIGKILLed process is reaped within milliseconds; this only ends a hang. */
const HANG_GUARD_MS = 10_000;
const started: number[] = [];
afterEach(() => { for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });

function scopes() {
  let record: ScopeRecord | undefined;
  const store: ScopeStore = {
    readWorkerScope: () => record ?? 'absent', writeWorkerScope: (_id, next) => { record = next; },
    getRun: id => ({ id, delegation: { role: 'worker' } }) as unknown as RunRecord,
    readWorkerExecution: () => undefined, readWorkerProcesses: () => 'absent',
  };
  return new WorkerScopes(store, () => ({ backend: 'groups', reason: 'darwin has no cgroups' }));
}

/** A group leader started through the scope; `script` prints the pid of the process to watch. */
async function launch(scope: WorkerScopes, workerId: string, script: string): Promise<{ leader: number; watched: number }> {
  const spawnScope = scope.spawnScope(workerId);
  const [file, args] = spawnScope.command(process.execPath, ['-e', script]);
  const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  spawnScope.started(child.pid!);
  started.push(child.pid!);
  const watched = await new Promise<number>(resolve => child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim()))));
  started.push(watched);
  return { leader: child.pid!, watched };
}

describe.runIf(process.platform === 'darwin')('worker scope on macOS', () => {
  it('stop ends the worker\'s own group, its leader and a member', async () => {
    const scope = scopes(), workerId = randomUUID();
    const { leader, watched } = await launch(scope, workerId,
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);");
    expect(scope.describe()).toEqual({ backend: 'groups', guarantee: 'scoped' });
    expect(await scope.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    await vi.waitFor(() => { expect(pidExists(watched)).toBe(false); expect(pidExists(leader)).toBe(false); }, { timeout: HANG_GUARD_MS });
  });

  it('a detached descendant outlives stop: the accepted macOS limit', async () => {
    const scope = scopes(), workerId = randomUUID();
    const { watched } = await launch(scope, workerId,
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid); setInterval(() => {}, 1000);");
    expect(await scope.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(watched)).toBe(true);
  });

  it('a group whose leader is gone is never signalled: no boot id proves its number', async () => {
    const scope = scopes(), workerId = randomUUID();
    const { leader, watched } = await launch(scope, workerId,
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); c.unref(); console.log(c.pid); setTimeout(() => process.exit(0), 200);");
    await vi.waitFor(() => expect(pidExists(leader)).toBe(false), { timeout: HANG_GUARD_MS });
    expect(await scope.stop(workerId, HANG_GUARD_MS)).toEqual({ stopped: true });
    expect(pidExists(watched)).toBe(true);
  });
});
