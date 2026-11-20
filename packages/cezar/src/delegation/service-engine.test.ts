import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { syncBuiltinESMExports } from 'node:module';
import '../core/created-runners.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-manager.testkit.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from "node:fs";
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from '../runs/store.ts';

import { fixture } from "./service-engine.testkit.ts";
import { seedWorkerWait } from "./service.testkit.ts";
import { workerCleanups } from './worker-cleanup.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);
registerRunner(opencodeRunner);

// A recovered manager, an open wait cancelled, and a restarted manager's process scan need the run engine.
describe('delegation service durable authority', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { scopeFixtureProcesses(); f = fixture(workerCleanups()); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
  const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });
  describe('explicit skill on spawn (hearsay-tools/cezarion#778)', () => {
    beforeEach(() => {
      f.manager.setSkillCatalog(fixedSkillCatalog([{ id: 'worker-skill', name: 'Worker skill', scope: 'repo', path: join(f.root, '.agents/skills/worker-skill/SKILL.md') }]));
    });
    it('refuses a tampered skill chain', async () => {
      const { workerId } = await f.service.spawn(f.caller, { ...input(), skill: 'worker-skill' });
      const workflow = f.store.getRun(workerId)!.workflowDef!;
      f.store.updateRun(workerId, { workflowDef: { ...workflow, steps: [{ ...workflow.steps[0]!, skill: 'injected' }] } });
      expect(() => f.manager.enqueueOwnedRun(workerId)).toThrow('Accepted worker workflow definition is unavailable or changed');
      // Preserve the root's human attention during recovery so it does not cancel the child.
      setRunStatus(f.store, f.parent.id, RUN_STATUS.waiting);
      f.manager.dispose();
      const recovered = createFixtureManager(f.store, f.root);
      try { await recovered.recover(); } finally { recovered.dispose(); }
      expect(f.store.getRun(workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('Accepted worker workflow definition is unavailable or changed') });
    });
  });
  /** A worker wait in the list (hearsay-tools/cezarion#1235, #1301), registered as `cez worker wait` does. */
  async function cancellableWait() {
    const { workerId } = await f.service.spawn(f.caller, input());
    return { workerId, waitId: seedWorkerWait(f.store, f.parent.id, [workerId]) };
  }
  it('cancels a queued parent wait without stopping its worker or authorizing new work', async () => {
    const { workerId, waitId } = await cancellableWait(); setRunStatus(f.store, f.parent.id, RUN_STATUS.queued);
    expect(await f.service.cancelWait(f.caller, { waitId })).toMatchObject({ wait: { id: waitId, phase: 'wake-pending', reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    await expect(f.service.wait(f.caller, { workerIds: [workerId], timeoutSeconds: 600 })).rejects.toMatchObject({ code: 'incompatible_state' });
    await expect(f.service.spawn(f.caller, input())).rejects.toMatchObject({ code: 'incompatible_state' });
  });
  it.each(['done', 'review', 'failed', 'cancelled'] as const)('reads the retained cancel receipt after the parent becomes %s', async status => {
    const { waitId } = await cancellableWait();
    const settled = await f.service.cancelWait(f.caller, { waitId });
    setRunStatus(f.store, f.parent.id, status);
    const before = structuredClone(f.store.getRun(f.parent.id));
    expect(await f.service.cancelWait(f.caller, { waitId })).toEqual(settled);
    expect(f.store.getRun(f.parent.id)).toEqual(before);
  });
  it('collect settles a worker whose crashed generation left no live process (#469)', { timeout: 15_000 }, async () => {
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.failed, { finishedAt: new Date().toISOString() });
    const record = join(f.root, '.ai/cezar/runs', `${workerId}.processes.json`);
    const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), controller: { pid: dead.pid, startToken: '1' } }));
    // The restart: the old manager and store go with the process.
    f.manager.dispose(); f.store.close();
    // The restarted cezar: a fresh manager owns no execution or queue entry for the worker.
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true }); const manager = createFixtureManager(reopened, f.root);
    f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: reopened, manager });
    try {
      // Under full-suite load the host-wide process scan can transiently return alive/unknown.
      // collect caches that conservative result for 2 s; poll it (not the finalizer) so the
      // assertion waits for proof of termination and still catches a missing collect hook (#703).
      await expect.poll(() => f.service.collect(f.caller, { workerId }), { timeout: 10_000, interval: 250 }).toMatchObject({ settled: true });
      expect(reopened.readWorkerExecution(workerId)).toMatchObject({ generation, phase: 'complete' });
    } finally { manager.dispose(); reopened.flush(); }
  });
  it('returns only the retained old cancellation while a queued parent has a newer wait', async () => {
    const { workerId, waitId } = await cancellableWait(); const old = await f.service.cancelWait(f.caller, { waitId });
    const next = { id: seedWorkerWait(f.store, f.parent.id, [workerId]) };
    setRunStatus(f.store, f.parent.id, RUN_STATUS.queued);
    expect(await f.service.cancelWait(f.caller, { waitId })).toEqual(old);
    await expect(f.service.cancelWait(f.caller, { waitId: randomUUID() })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(f.store.getRun(f.parent.id)?.waits).toEqual([expect.objectContaining({ id: next.id, kind: WAIT_KIND.worker, phase: WAIT_PHASE.open })]);
  });
});
