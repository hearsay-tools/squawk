import { ABSENT_PROCESS_PID } from '../delegation/process-enumeration.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { ownedWorkspace } from '@open-mercato/cezar-contract/delegation';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { groupHolder, orphanedGroupHolder, nonDumpableHolder, readableHolder } from '../delegation/non-dumpable.testkit.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';
import { processStartToken } from '../core/process-stat.ts';
import * as worktreeLock from '../git-worktree-lock.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import { isLiveRecord } from '../runs/run-row.ts';
import { historyPaths } from '../runs/history-file.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, until, executions, bookkeeping, reopenRuntime, useWorkerWaitFixture } from './worker-wait-core.testkit.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';
import { RESTART_GROUPS } from './worker-restart-rows.testkit.ts';
import { workerExecutionsOf } from '../delegation/worker-executions.ts';

// Native wires, tokens, process groups, cancellation, persistence, Git locking, collection and
// parent Finish are real. Worker ownership comes from the scope and the process ledger (ADR 0032).

/** The runners each group runs on: a shared family (core/parity-classes.testkit.ts), whose
 *  runner part, the native processes the ledger records, seam row S43 holds on every runner. */
export const RESTART_RUNNERS = { r47: parityRunners('worker-restart', 'R47'), r60: parityRunners('worker-restart', 'R60') };

export function registerRestartGroup(group: keyof typeof RESTART_GROUPS): void {
 describe.runIf(process.platform === 'linux')('R47 same-boot interrupted worker settlement (hearsay-tools/cezarion#839, hearsay-tools/cezarion#889)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // Pinned so a fixture group leader can join the worker's scope on every host.
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); setHostScope(undefined); });
  if (group === 'starting-proof') {
it.each(RESTART_RUNNERS.r60)('%s R60 cold terminal starting-proof recovery repairs execution without a synchronous facts join', async runner => {
    // Explicit opt-in: this recovery fixture seeds an inactive parent and registers the rebuilt runtime.
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner]!; process.env[adapter.binEnv]! = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, p.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!, runner);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const proof = store.workerExecutions.readWorkerExecution(w.id)!;
    expect(proof.phase).toBe('starting');
    const recorded = store.workerExecutions.readWorkerProcesses(w.id, proof.generation);
    if (typeof recorded === 'string') throw Error('missing native process ledger');
    expect(recorded.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
    // Public completion can be durable before its private completion checkpoint.
    setRunStatus(store, w.id, RUN_STATUS.done, { stopping: undefined });
    setRunStatus(store, p.id, RUN_STATUS.done);
    for (const id of [p.id, w.id]) expect(isLiveRecord(store.getRun(id)!)).toBe(false);
    const dataDir = join(root, '.ai/cezar'); const files = join(dataDir, 'runs');
    const before = store.eventLog.readEvents(w.id);
    expect(before.length).toBeGreaterThan(0);
    store.persistence.flush(); store.close();
    writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
      controller: { pid: ABSENT_PROCESS_PID, startToken: `${boot}:100` } }));
    for (const id of [p.id, w.id]) rmSync(historyPaths(dataDir, id).facts, { force: true });
    const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
    reopenRuntime();
    expect(store.queries.listRuns()).toEqual([]); // no live, legacy or deferred family anchor
    expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting', generation: proof.generation });
    expect(existsSync(historyPaths(dataDir, w.id).facts)).toBe(false);
    // No pre-awaited global warming: boot recovery itself owns readiness.
    await manager.recover();
    expect(joins).not.toHaveBeenCalled();
    expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
    expect(store.workerExecutions.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
    expect(store.getRun(w.id)?.status).toBe('done'); expect(store.getRun(p.id)?.status).toBe('done');
    const events = store.eventLog.readEvents(w.id);
    const repaired = events.filter(e => e.type === 'lifecycle' && /execution was finalized/.test(String(e.message)));
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.seq).toBeGreaterThan(before.at(-1)!.seq);
    expect(new Set(events.map(e => e.seq)).size).toBe(events.length);
  });
}
  if (group === 'starting-proof') {
    it.each(RESTART_RUNNERS.r47)('%s Continue after a controller crash stops the recorded processes the old generation left, then starts the next one', async runner => {
      process.env.CEZ_DRY_RUN = '0';
      const adapter = HARNESS_ADAPTERS[runner]!; process.env[adapter.binEnv]! = adapter.mockBin;
      const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
      setRunStatus(store, p.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
      const w = await worker(p.id, adapter.scenarios.baseline!, runner);
      store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting');
      const proof = store.workerExecutions.readWorkerExecution(w.id)!;
      const recorded = store.workerExecutions.readWorkerProcesses(w.id, proof.generation);
      if (typeof recorded === 'string') throw Error('missing native process ledger');
      expect(recorded.processes.length).toBeGreaterThan(0);
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
      const workspace = w.delegation?.role === 'worker' ? ownedWorkspace(w.delegation.workspace) : undefined;
      if (!workspace) throw Error('missing workspace');
      const files = join(root, '.ai/cezar/runs');
      writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
      // The crashed controller left a recorded group leader running; another process works in the
      // worktree outside the worker's scope.
      const survivor = await orphanedGroupHolder(root);
      const outside = await readableHolder(workspace.path);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
        controller: { pid: ABSENT_PROCESS_PID, startToken: `${boot}:100` },
        processes: [...recorded.processes, { pid: survivor.pid, pgid: survivor.pid, startToken: processStartToken(survivor.pid) }] }));
      store.persistence.flush(); reopenRuntime();
      try {
        expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ phase: 'starting', generation: proof.generation });
        expect(survivor.running).toBe(true);
        // Decision 6: Continue ends the old generation's processes instead of refusing.
        expect(manager.continueRun(w.id)).toMatchObject({ ok: true });
        await until(() => !survivor.running);
        const next = store.workerExecutions.readWorkerExecution(w.id)!;
        expect(next.generation).not.toBe(proof.generation);
        const lifecycle = store.eventLog.readEvents(w.id).filter(e => e.type === 'lifecycle').map(e => String(e.message));
        expect(lifecycle.filter(message => /Continue stopped the processes/.test(message))).toHaveLength(1);
        expect(lifecycle.some(message => /execution was finalized/.test(message))).toBe(true);
        await until(() => store.getRun(w.id)?.status === 'waiting');
        expect(store.workerExecutions.readWorkerExecution(w.id)?.generation).toBe(next.generation);
        expect(outside.running).toBe(true); // outside the worker's scope: never signalled
        await outside.write();
        manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      } finally { await survivor.close(); await outside.close(); }
    });
    it.each(RESTART_RUNNERS.r47)('%s Continue after a crash that recovery already settled still stops what the crash left in the scope', async runner => {
      process.env.CEZ_DRY_RUN = '0';
      const adapter = HARNESS_ADAPTERS[runner]!; process.env[adapter.binEnv]! = adapter.mockBin;
      const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
      setRunStatus(store, p.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
      const w = await worker(p.id, adapter.scenarios.baseline!, runner);
      store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting');
      const proof = store.workerExecutions.readWorkerExecution(w.id)!;
      const recorded = store.workerExecutions.readWorkerProcesses(w.id, proof.generation);
      if (typeof recorded === 'string') throw Error('missing native process ledger');
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
      const files = join(root, '.ai/cezar/runs');
      writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
      // The crash left a service the worker's setup started, in its scope only; its sessions are gone.
      const service = await orphanedGroupHolder(root);
      workerExecutionsOf(store).scopes.spawnScope(w.id).started(service.pid);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
        controller: { pid: ABSENT_PROCESS_PID, startToken: `${boot}:100` } }));
      store.persistence.flush(); reopenRuntime();
      try {
        // Recovery settles the generation first, and marks it interrupted.
        await manager.recover();
        expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', generation: proof.generation, interrupted: true });
        expect(service.running).toBe(true);
        expect(manager.continueRun(w.id)).toMatchObject({ ok: true });
        // Admission waited for the scope to empty: nothing old runs beside the new execution.
        expect(store.workerExecutions.scopes.empty(w.id)).toBe(true);
        await until(() => !service.running);
        expect(store.workerExecutions.readWorkerExecution(w.id)?.generation).not.toBe(proof.generation);
        await until(() => store.getRun(w.id)?.status === 'waiting');
        manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      } finally { await service.close(); }
    });
  }
  if (group === 'destroy-absent-ledger' || group === 'destroy-incomplete-ledger') {
   const ledgerKind = group === 'destroy-absent-ledger' ? 'absent' : 'incomplete';
    it.each(RESTART_RUNNERS.r47)(`%s destroy ends the worker's scope and leaves outside holders running (${ledgerKind} ledger)`, async runner => {
      process.env.CEZ_DRY_RUN = '0';
      const adapter = HARNESS_ADAPTERS[runner]!; process.env[adapter.binEnv]! = adapter.mockBin;
      const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
      setRunStatus(store, p.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
      const w = await worker(p.id, adapter.scenarios.baseline!, runner);
      store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
      await until(() => store.getRun(w.id)?.status === 'waiting');
      const proof = store.workerExecutions.readWorkerExecution(w.id)!;
      const recorded = store.workerExecutions.readWorkerProcesses(w.id, proof.generation);
      if (typeof recorded === 'string') throw Error('missing native process ledger');
      expect(recorded.processes.length).toBeGreaterThan(0);
      manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
      const workspace = w.delegation?.role === 'worker' ? ownedWorkspace(w.delegation.workspace) : undefined;
      if (!workspace) throw Error('missing workspace');
      const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
      const files = join(root, '.ai/cezar/runs');
      writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
      if (ledgerKind === 'absent') rmSync(join(files, `${w.id}.processes.json`));
      else {
        const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        // Structurally valid legacy evidence with a missing incarnation token.
        writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...recorded,
          controller: { pid: ABSENT_PROCESS_PID, startToken: `${boot}:100` },
          processes: recorded.processes.map(({ pid }) => ({ pid })) }));
      }
      // One process in the worker's scope, and two outside it that work in its paths.
      const owned = await groupHolder(root);
      const readable = await readableHolder(workspace.path);
      const unreadable = await nonDumpableHolder(scratch);
      setRunStatus(store, w.id, RUN_STATUS.waiting); store.persistence.flush(); reopenRuntime();
      workerExecutionsOf(store).scopes.spawnScope(w.id).started(owned.pid);
      const service = new DelegationService(workerCleanups({ terminationTimeoutMs: 4_000 })); const detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
      try {
        expect(store.workerExecutions.scopes.empty(w.id)).toBe(false);
        expect(await service.destroyForHuman('project', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        await until(() => !owned.running);
        expect(store.workerExecutions.scopes.empty(w.id)).toBe(true);
        expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ generation: proof.generation, phase: 'complete' });
        expect(store.workerExecutions.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
        expect(existsSync(workspace.path)).toBe(false);
        expect(execFileSync('git', ['branch', '--list', '--format=%(refname:short)', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
        // Outside the worker's scope: never signalled, and never waited for.
        expect(readable.running).toBe(true); expect(unreadable.running).toBe(true);
      } finally {
        detach(); await owned.close(); await readable.close(); await unreadable.close();
      }
    });
 }
 if (group === 'same-boot-crash-lock') {
it.each(RESTART_RUNNERS.r47)('%s settles a same-boot crash as gone once recorded processes exit, whatever outside process runs, and keeps cleanup locks bounded', async runner => {
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner]!; process.env[adapter.binEnv]! = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] });
    setRunStatus(store, p.id, RUN_STATUS.waiting, { currentStepId: 'task', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.baseline!, runner);
    store.updateRun(w.id, { runner }); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const proof = store.workerExecutions.readWorkerExecution(w.id)!;
    const recorded = store.workerExecutions.readWorkerProcesses(w.id, proof.generation);
    if (typeof recorded === 'string') throw Error('missing native process ledger');
    expect(recorded.processes.length).toBeGreaterThan(0);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
    await Promise.all(executions.splice(0)); await Promise.all(bookkeeping.splice(0)); manager.dispose();
    const workspace = w.delegation?.role === 'worker' ? ownedWorkspace(w.delegation.workspace) : undefined;
    if (!workspace) throw Error('missing workspace');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'scratch');
    const files = join(root, '.ai/cezar/runs');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const ledger = { ...recorded, controller: { pid: ABSENT_PROCESS_PID, startToken: `${boot}:100` } };
    writeFileSync(join(files, `${w.id}.execution.json`), JSON.stringify(proof));
    // A real unreadable recorded descendant still blocks settlement, regardless of cwd.
    const descendant = await nonDumpableHolder(root);
    let descendantClosed = false;
    // A process outside the worker's scope that works in the worktree is not the worker's (ADR 0032).
    const ambient = await readableHolder(workspace.path); let ambientClosed = false;
    writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...ledger,
      processes: [...ledger.processes, { pid: descendant.pid, startToken: processStartToken(descendant.pid) }] }));
    setRunStatus(store, w.id, RUN_STATUS.waiting); store.persistence.flush(); reopenRuntime();
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', p.id, 'test'))!;
    let service = new DelegationService(workerCleanups()); let detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
    try {
      const partial = await service.collect(caller, { workerId: w.id });
      expect(partial).toMatchObject({ settled: false });
      expect(manager.finish(p.id)).toBe(false);
      expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ generation: proof.generation, phase: 'starting' });
      await descendant.write(); await descendant.close(); descendantClosed = true;
      // Include PID reuse: ambient PID cannot attest the exited old incarnation.
      writeFileSync(join(files, `${w.id}.processes.json`), JSON.stringify({ ...ledger,
        processes: [...ledger.processes, { pid: ambient.pid, startToken: `${boot}:1` }] }));
      detach(); manager.dispose(); store.persistence.flush(); reopenRuntime(); await manager.recover();
      // An explicit destroy waits its own bounded time for the lock; 1 s here, so the hang guard below stays far off.
      service = new DelegationService(workerCleanups({ manualLockWaitMs: 1_000 })); detach = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
      // Exit proof, not abandonment: the generation completes and nothing cancels the task.
      expect(store.workerExecutions.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete', generation: proof.generation });
      expect(store.workerExecutions.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
      expect(store.eventLog.readEvents(w.id).some(e => e.type === 'lifecycle' && /execution was finalized/.test(String(e.message)))).toBe(true);
      expect(store.eventLog.readEvents(w.id).some(e => e.type === 'lifecycle' && /abandoned/.test(String(e.message)))).toBe(false);
      expect(manager.finish(p.id)).toBe(false); // earlier partial collection cannot authorize Finish
      // A live mutation keeper must not be stolen, and the destroy must give up on it rather than
      // wait for it: the keeper is released only after the destroy returns. The timer ends a red
      // test instead: the old unbounded cleanup then wrongly deletes resources after the release.
      let release!: () => void; let entered!: () => void; let released = false;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const held = withWorktreeMutation(root, async () => { entered(); await new Promise<void>(resolve => { release = () => { released = true; resolve(); }; }); });
      await ready;
      // bound: a hang guard for the red test only; a bounded destroy returns long before it.
      const timer = setTimeout(() => release(), 15_000);
      const locks = vi.spyOn(worktreeLock, 'withWorktreeMutation');
      try {
        // The holders write `holder-writes` into the worktree: uncommitted work these destroys discard (hearsay-tools/squawk#3553).
        expect(await service.destroyForHuman('project', w.id, { discardWork: true })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'], error: expect.stringMatching(/lock.*busy|lock.*timed out/i) });
        expect(released).toBe(false);
        // The destroy asks for the lock with its own bounded budget, never the default two minutes.
        expect(locks.mock.calls.map(([, , options]) => options?.waitMs)).toEqual([1_000]);
        expect(existsSync(workspace.path)).toBe(true);
        expect(execFileSync('git', ['branch', '--list', '--format=%(refname:short)', workspace.branch], { cwd: root, encoding: 'utf8' }).trim()).toBe(workspace.branch);
      } finally { locks.mockRestore(); clearTimeout(timer); release(); await held; }
      // Timed-out cleanup must withdraw, so unlocking cannot run it later.
      expect(existsSync(workspace.path)).toBe(true);
      await ambient.write();
      expect(await service.destroyForHuman('project', w.id, { discardWork: true })).toMatchObject({ state: 'complete', remaining: [] });
      expect(existsSync(workspace.path)).toBe(false);
      expect(ambient.running).toBe(true); // its cwd is gone, but nothing signalled it
      const settled = await service.collect(caller, { workerId: w.id });
      expect(settled).toMatchObject({ settled: true });
      expect(settled.revision).toBe(partial.revision); // settlement does not invent a new execution revision
      expect(manager.finishBlockedReason(p.id)).toBeUndefined(); expect(manager.finish(p.id)).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    } finally {
      detach(); credentials.close();
      if (!descendantClosed) await descendant.close(); if (!ambientClosed) await ambient.close();
    }
  });
 }
 });
}
