import { ABSENT_PROCESS_PID } from '../delegation/process-enumeration.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { ownedWorkspace, workerCollectedResultSchema } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { groupHolder, nonDumpableHolder, readableHolder } from '../delegation/non-dumpable.testkit.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { manager, store, root, worker, until, semaphore, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';

// A shared family (core/parity-classes.testkit.ts): seam row S43 holds each runner to reporting the
// native processes the ledger records, and runner-shutdown to stopping them.
const runners = parityRunners('worker-reboot', 'R43');
export const GROUPS = { collect: runners, destroy: runners, reuse: runners };
export function registerGroup(settleVia: keyof typeof GROUPS) {
describe.runIf(process.platform === 'linux')('R43 reboot orphan settlement (hearsay-tools/cezarion#738)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // Pinned so a fixture group leader can join the worker's scope on every host.
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); setHostScope(undefined); });

  if (settleVia !== 'reuse') it.each(GROUPS[settleVia])(`%s ${settleVia} settles and clears parent Finish; after restart, cleanup completes while an outside holder runs`, async runner => {
    // Service collection is opt-in; useWorkerWaitFixture restores the caller's environment.
    // Explicit opt-in: this recovery fixture seeds an inactive parent and registers the rebuilt runtime.
    const adapter = HARNESS_ADAPTERS[runner];
    process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] });
    setRunStatus(store, p.id, RUN_STATUS.waiting, { currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const orphan = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(orphan.id, { runner }); manager.enqueueOwnedRun(orphan.id);
    await until(() => store.getRun(orphan.id)?.status === 'waiting');
    const files = join(root, '.ai/cezar/runs');
    const proof = store.readWorkerExecution(orphan.id)!;
    expect(proof.phase).toBe('starting');
    const processes = store.readWorkerProcesses(orphan.id, proof.generation);
    if (typeof processes === 'string') throw Error('missing native process record');
    expect(processes.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(orphan.id);
    expect(await manager.awaitRunTermination(orphan.id, 15_000)).toBe(true);

    const twin = await worker(p.id, adapter.scenarios['cezar-done']!);
    store.updateRun(twin.id, { runner }); manager.enqueueOwnedRun(twin.id);
    await until(() => store.readWorkerExecution(twin.id)?.phase === 'complete');
    expect(store.getRun(twin.id)?.status).toBe('done');
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0));
    manager.dispose();
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))![1]) * 1000;
    store.updateRun(orphan.id, { createdAt: new Date(boot - 60_000).toISOString() });
    store.flush();
    // Restore only crash evidence, not a forged completion: native children have really exited.
    writeFileSync(join(files, `${orphan.id}.execution.json`), JSON.stringify(proof));
    writeFileSync(join(files, `${orphan.id}.processes.json`), JSON.stringify({ ...processes, controller: { pid: ABSENT_PROCESS_PID, startToken: '11111111-1111-4111-8111-111111111111:100' } }));
    const workspace = orphan.delegation?.role === 'worker' ? ownedWorkspace(orphan.delegation.workspace) : undefined;
    if (!workspace) throw Error('missing workspace');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), orphan.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
    // Unknown location evidence blocks legacy settlement, but cannot negate known-reboot
    // execution proof. The independent cleanup still requires this evidence to recover.
    // The holder is outside the worker's scope, so it holds nothing of the worker's (ADR 0032).
    const receipt = join(scratch, '.cez-fallback-removal.json');
    writeFileSync(receipt, '{corrupt', { mode: 0o600 });
    const holder = await readableHolder(settleVia === 'collect' ? scratch : workspace.path);
    reopenRuntime();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', p.id, 'test'))!;
    let service = new DelegationService(workerCleanups(settleVia === 'destroy' ? { terminationTimeoutMs: 100 } : {})); let detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
    let holderClosed = false;
    try {
      expect(await service.collect(caller, { workerId: twin.id })).toMatchObject({ settled: true, status: workerCollectedResultSchema.shape.status.enum.done });
      expect(manager.finishBlockedReason(p.id)).toContain(orphan.id);
      expect(manager.finish(p.id)).toBe(false);
      if (settleVia === 'destroy') {
        // The damaged location receipt, not the holder, retains both resources.
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
      }
      const resourceProbe = vi.spyOn(fs, 'readlinkSync'); syncBuiltinESMExports();
      resourceProbe.mockClear();
      expect(await service.collect(caller, { workerId: orphan.id })).toMatchObject({ settled: true, status: workerCollectedResultSchema.shape.status.enum.cancelled });
      expect(existsSync(scratch)).toBe(true);
      expect(resourceProbe.mock.calls.filter(([path]) => String(path).startsWith('/proc/'))).toHaveLength(0);
      expect(store.readWorkerExecution(orphan.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
      expect(manager.finishBlockedReason(p.id)).toBeUndefined();
      expect(manager.finish(p.id)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      expect(resourceProbe.mock.calls.filter(([path]) => String(path).startsWith('/proc/'))).toHaveLength(0);
      // Restoring the location evidence leaves only the holder, which proves nothing.
      rmSync(receipt);
      await until(() => store.getRun(p.id)?.status === 'done');
      expect(semaphore.busy()).toBe(0);
      // Production 60s timers, no shortened override or manual scratch cleanup call: recovered
      // cleanup releases every resource on its next wake while the holder still runs.
      detach(); manager.dispose(); store.flush(); reopenRuntime();
      await manager.recover();
      service = new DelegationService(workerCleanups()); detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
      service.armDestroyRetries('project');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      if (settleVia === 'collect') {
        expect(existsSync(workspace.path)).toBe(true); // collection never requests worktree removal
        expect(await service.destroyForHuman('project', orphan.id)).toMatchObject({ state: 'complete', remaining: [] });
      }
      vi.useRealTimers();
      await until(() => !existsSync(workspace.path) && !existsSync(scratch));
      await until(() => store.getRun(orphan.id)?.delegation?.role === 'worker' &&
        (store.getRun(orphan.id)!.delegation as { destroy?: { phase: string } }).destroy?.phase === 'complete');
      expect(holder.running).toBe(true); // its cwd is gone, but nothing signalled it
      expect(execFileSync('git', ['branch', '--list', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
      expect(store.readWorkerResult(p.id, orphan.id)).toMatchObject({ settled: true, cleanup: 'complete' });
      expect(store.getRun(p.id)?.status).toBe('done');
      expect(store.canDeleteRun(orphan.id)).toBe(true);
      await holder.close(); holderClosed = true;
      // With every resource physically absent, an ambient denial cannot strand history.
      const ambient = await nonDumpableHolder(root);
      try { expect(store.canDeleteRun(orphan.id)).toBe(true); } finally { await ambient.close(); }
      // A completed cleanup/checkpoint cannot authorize later history removal over a live recorded
      // process of the generation.
      mkdirSync(scratch, { recursive: true });
      const survivor = await readableHolder(root);
      writeFileSync(join(files, `${orphan.id}.processes.json`), JSON.stringify({ ...processes,
        controller: { pid: ABSENT_PROCESS_PID, startToken: '11111111-1111-4111-8111-111111111111:100' },
        processes: [...processes.processes, { pid: survivor.pid, startToken: processStartToken(survivor.pid) }] }));
      try {
        expect(store.deleteRun(orphan.id)).toBe(false);
        expect(existsSync(join(files, `${orphan.id}.processes.json`))).toBe(true);
        expect(existsSync(join(files, `${orphan.id}.execution.json`))).toBe(true);
      } finally { await survivor.close(); }
      // Outside processes in its scratch, readable or not, do not stop it and are never signalled.
      const readable = await readableHolder(scratch); const unreadable = await nonDumpableHolder(scratch);
      try {
        expect(store.deleteRun(orphan.id)).toBe(true);
        expect(readable.running).toBe(true); expect(unreadable.running).toBe(true);
      } finally { await readable.close(); await unreadable.close(); }
      expect(existsSync(scratch)).toBe(false);
    } finally { detach(); credentials.close(); if (!holderClosed) await holder.close(); vi.useRealTimers(); }
  });
  if (settleVia === 'reuse') it.each(GROUPS[settleVia])('%s retains scratch for a scoped process, never for an outside holder, and a stale cleanup wake preserves the next native execution', async runner => {
    const adapter = HARNESS_ADAPTERS[runner];
    process.env.CEZ_DRY_RUN = '0'; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] });
    setRunStatus(store, p.id, RUN_STATUS.waiting, { currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0));
    const generation = store.readWorkerExecution(w.id)!.generation;
    // Nothing holds the old scratch yet: keep the cleanup the stop scheduled from racing the fixture.
    manager.pauseWorkerCleanup();
    const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'old task scratch');
    // A process in the worker's scope holds its scratch; one outside it holds nothing (ADR 0032).
    const scoped = await groupHolder(scratch); store.scopes.spawnScope(w.id).started(scoped.pid);
    const holder = await readableHolder(scratch);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      manager.recoverWorkerCleanup(); await vi.advanceTimersByTimeAsync(0);
      expect(readFileSync(join(scratch, 'retained'), 'utf8')).toBe('old task scratch');
      await scoped.write(); await scoped.close();
      // A cleanup retry is captured against generation one. Admit generation two using the real
      // native continuation and give it task scratch before that old timer fires.
      expect(manager.continueRun(w.id)).toMatchObject({ ok: true });
      const next = store.readWorkerExecution(w.id)!; expect(next.generation).not.toBe(generation);
      writeFileSync(join(scratch, 'new-generation'), next.generation);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readFileSync(join(scratch, 'new-generation'), 'utf8')).toBe(next.generation);
      vi.useRealTimers();
      await until(() => store.getRun(w.id)?.status === 'waiting');
      expect(typeof store.readWorkerProcesses(w.id, next.generation)).toBe('object');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await until(() => !existsSync(scratch));
      expect(holder.running).toBe(true);
    } finally { await scoped.close(); await holder.close(); vi.useRealTimers(); }
  });

});
}
