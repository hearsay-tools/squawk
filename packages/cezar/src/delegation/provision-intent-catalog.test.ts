import '../core/every-runner.testkit.ts';
import { openTestRunStore, runPersistence } from '../runs/run-store-open.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { provisionWorkflowFixture, delegationToken, until, PROVISION_ROWS } from './provision-workflows.testkit.ts';
import { readWorkerIdentity } from './execution-identity.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('manager session delegation lifecycle', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, acceptIdentityWorker, launchAccepted, doneTurn } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });

  it.each(PROVISION_ROWS.governedIntent)('provisions governed intent for $backend on $mode', async ({ backend, mode }) => {
    const workflow = mode === 'noninteractive'
      ? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, id: 'preflight' }, QUICK_TASK_WORKFLOW.steps[0]!] }
      : QUICK_TASK_WORKFLOW;
    let run;
    if (mode === 'recovery') {
      run = f.store.createRun({ title: 'queued', task: 'recover', workflow: 'quick-task', runner: backend, steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
      await f.manager.recover();
    } else run = f.manager.startRun(workflow, { task: 'parent', runner: backend, worktree: false, ...(mode === 'off' ? { allowWorkers: false, allowMessaging: false } : {}) });
    await until(() => sessions.length === 1);
    const initial = sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN;
    if (mode === 'continue') {
      sessions[0]!.finish(); await until(() => !f.manager.isActive(run.id));
      expect(f.manager.continueRun(run.id, { text: 'continue' }).ok).toBe(true);
      await until(() => sessions.length === 2);
      expect(sessions[1]!.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(initial);
    }
    const spec = sessions.at(-1)!.spec;
    if (mode === 'off') {
      // hearsay-tools/cezarion#2784: both switches off issue no credential; the governed-session cross-session controls stay.
      expect(spec.restrictCrossSessionMessaging).toBe(true);
      expect(spec.env?.CEZ_DELEGATION_TOKEN).toBeUndefined();
      expect(spec.systemPrompt).toContain(`Squawk workers and task messaging are off for this task`);
    } else {
      expect(spec.restrictCrossSessionMessaging).toBe(true);
      expect(spec.systemPrompt).toContain('cezar');
      expect(spec.systemPrompt).toContain('--effort');
      expect(spec.systemPrompt).toContain('--workflow');
      expect(controller.credentials.authenticate(delegationToken(spec))).toMatchObject({ runId: run.id });
    }
    // These mocked roots still finish asynchronously after cancellation. Wait before
    // afterEach removes their repository, especially recovery's worktree metadata.
    f.manager.cancel(run.id);
    for (const session of sessions) session.finish();
    await until(() => !f.manager.isActive(run.id));
  });
  it('executes a catalog workflow in the worker: a failing check loops back once, then the chain settles (#451)', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    // The check fails on its first invocation only, from inside the worker's own worktree.
    writeFileSync(join(dir, 'review.yaml'), [
      'name: review', 'steps:',
      '  - id: inspect', '    name: Inspect', '    prompt: "Review: {{task}}"',
      '  - id: verify', '    command: test -f .verified || { touch .verified; echo first-run-fails; exit 1; }',
      '    onFail: { retry: inspect, max: 2 }',
    ].join('\n'));
    const parent = f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID(), workflow: 'review' });
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.userPrompt).toContain('Review: child');
    expect(sessions[1]!.spec.cwd).not.toBe(f.root);
    doneTurn(sessions[1]!, 'first attempt');
    // The check fails, so the agent step runs again with the failing output appended.
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.userPrompt).toContain('first-run-fails');
    doneTurn(sessions[2]!, 'second attempt');
    // No committed diff and no review gate in this fixture: the chain settles as done.
    await until(() => f.store.getRun(child.workerId)?.status === 'done');
    const worker = f.store.getRun(child.workerId)!;
    expect(worker.steps.map(step => ({ id: step.id, kind: step.kind, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'inspect', kind: STEP_KIND.agent, status: STEP_STATUS.done, iterations: 2 }, { id: 'verify', kind: STEP_KIND.check, status: STEP_STATUS.done, iterations: 2 },
    ]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toHaveLength(2);
    expect(f.store.getRun(parent.id)?.delegation).toMatchObject({ role: 'root' });
  });
  // hearsay-tools/cezarion#1620: an earlier step that ends without done settles the worker as a
  // single-step task's close does, keeps the step open, and a parent resume re-enters it.
  it('settles a worker whose earlier step ends without done, and a parent resume re-enters that step', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.yaml'), [
      'name: review', 'steps:',
      '  - id: inspect', '    name: Inspect', '    prompt: "Review: {{task}}"',
      '  - id: verify', '    command: "true"',
    ].join('\n'));
    f.manager.startRun(QUICK_TASK_WORKFLOW, { task: 'parent', runner: 'claude', worktree: false });
    await until(() => sessions.length === 1);
    const caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    const child = await controller.service.spawn(caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID(), workflow: 'review' });
    await until(() => sessions.length === 2);
    sessions[1]!.finish('stopped early');
    await until(() => f.store.getRun(child.workerId)?.status === 'done');
    const steps = () => f.store.getRun(child.workerId)!.steps.filter(step => step.id === 'inspect' || step.id === 'verify').map(step => [step.id, step.status]);
    expect(steps()).toEqual([['inspect', 'waiting'], ['verify', 'pending']]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toEqual([]);
    await controller.service.send(caller, { id: randomUUID(), recipientRunId: child.workerId, kind: 'request', text: 'Finish the review', resume: true, timeoutSeconds: 600 });
    await until(() => sessions.length === 3);
    doneTurn(sessions[2]!, 'reviewed');
    await until(() => f.store.getRun(child.workerId)?.status === 'done' && steps()[1]?.[1] === 'done');
    expect(steps()).toEqual([['inspect', 'done'], ['verify', 'done']]);
    expect(f.store.readEvents(child.workerId).filter(event => event.type === 'check-output')).toHaveLength(1);
  });
  it.each(PROVISION_ROWS.catalogMutation)('refuses a catalog worker whose public workflow definition was edited after acceptance on %s (#451)', async mode => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.yaml'), 'name: review\nsteps:\n  - id: inspect\n    prompt: "Review: {{task}}"\n  - id: verify\n    command: "true"\n');
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'review' });
    expect(readWorkerIdentity(f.store.workerExecutions, a.child.workerId)).toMatchObject({ workflowHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    if (mode === 'continue') {
      await launchAccepted(a, mode); await until(() => sessions.length === 2);
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    }
    const worker = f.store.getRun(a.child.workerId)!;
    f.store.updateRun(worker.id, { workflowDef: { ...worker.workflowDef!, steps: [{ id: 'inspect', prompt: 'injected {{task}}' }, { id: 'verify', command: 'exit 99' }] } });
    if (mode === 'continue') expect(f.manager.continueRun(worker.id, { text: 'again' })).toMatchObject({ ok: false, error: expect.stringContaining('workflow') });
    else {
      const { store } = await launchAccepted(a, mode);
      await until(() => store.getRun(worker.id)?.status === 'failed' || sessions.length > 1);
      expect(store.getRun(worker.id)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('workflow') });
    }
    expect(sessions).toHaveLength(mode === 'continue' ? 2 : 1);
  });
  it('refuses a failed continuation checkpoint without advancing revision or opening another session', async () => {
    const a = await acceptIdentityWorker(); await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'worker-session', resumed: false }); sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    const run = f.store.getRun(a.child.workerId)!; const steps = structuredClone(run.steps);
    const failure = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation(() => { throw Error('disk failure'); });
    expect(f.manager.continueRun(run.id, { text: 'again' })).toMatchObject({ ok: false });
    expect(run.delegation).not.toHaveProperty('executionRevision'); expect(run.steps).toEqual(steps);
    failure.mockRestore();
    await until(() => !f.manager.isActive(run.id));
    expect(sessions).toHaveLength(2);
  });
  it('persists result-only assistant evidence on initial execution and authorized Continue', async () => {
    const a = await acceptIdentityWorker(); await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'worker-session', resumed: false });
    sessions[1]!.finish('Initial result-only summary');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(await controller.service.collect(a.caller, { workerId: a.child.workerId })).toMatchObject({ revision: 0, settled: true, summary: { state: 'available', text: 'Initial result-only summary' } });
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    expect(f.store.getRun(a.child.workerId)?.delegation).toMatchObject({ executionRevision: 1 });
    const disk = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(disk.getRun(a.child.workerId)?.delegation).toMatchObject({ executionRevision: 1 }); disk.flush();
    await until(() => sessions.length === 3);
    sessions[2]!.finish('Continuation result-only summary');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(await controller.service.collect(a.caller, { workerId: a.child.workerId })).toMatchObject({ revision: 1, settled: true, summary: { state: 'available', text: 'Continuation result-only summary' } });
  });
});
