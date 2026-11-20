import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct, setupMonitoringFixture, FINISHED_RUN_STATUSES } from './run-fixture.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { type WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const launches: AgentRunSpec[] = [];

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base');
    await run('git', ['add', 'base.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    launches.length = 0;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: spec => {
        launches.push(spec);
        return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false, end: () => undefined, interrupt: () => undefined, open: false };
      },
    };
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it.each([
    { name: 'different backend', step: {}, options: { runner: 'codex' }, resume: false, backend: 'codex' },
    { name: 'same backend', step: { backend: 'claude' }, options: { runner: 'claude' }, resume: true, backend: 'claude' },
    { name: 'owning account', step: { backend: 'claude', profileId: 'klaudiusz' }, agentProfile: 'klaudiusz', options: {}, resume: true, backend: 'claude' },
    { name: 'legacy default account', step: { backend: 'claude' }, agentProfile: 'default', options: {}, resume: true, backend: 'claude' },
  ] as const)('resumes only on the owning backend and account: $name', async ({ step, options, resume, backend, ...run }) => {
    const id = resumableRun();
    if ('agentProfile' in run) store.updateRun(id, { agentProfile: run.agentProfile });
    store.updateStep(id, 's1', step);
    expect(manager.continueRun(id, options)).toEqual({ ok: true });
    await waitForProduct(manager, store, () => launches.length === 1);
    if (resume) expect(launches[0]).toMatchObject({ resume: true, sessionId: 'sess-1' });
    else expect(launches[0]?.resume).not.toBe(true);
    expect(store.getRun(id)?.steps.at(-1)?.backend).toBe(backend);
  });
});

describe('RunManager idle shutdown', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('honors cancellation that races an idle-close callback', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    expect(fixture.manager.cancel(record.id)).toBe(true);
    await waitFor(record.id, candidate => candidate?.status === 'cancelled');
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.cancelled });
    expect(fixture.store.getRun(record.id)?.finishedAt).toBeDefined();
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.cancelled }),
    ]));
  }, 30_000);

  it('publishes a runner failure that occurs during idle shutdown', async () => {
    const clock = fixture.observeIdleTimers();
    runnerHook.runner = {
      backend: 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession: (_spec, onEvent) => {
        let rejectResult: (error: Error) => void = () => undefined;
        const result = new Promise<AgentRunResult>((_resolve, reject) => { rejectResult = reject; });
        let open = true;
        queueMicrotask(() => onEvent?.({ type: 'turn-end' }));
        return {
          result,
          sendMessage: () => false,
          sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: () => {
            open = false;
            rejectResult(new Error('provider failed during shutdown'));
          },
          interrupt: () => { open = false; },
          get open() { return open; },
        };
      },
    };
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'wait then fail', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, candidate => candidate?.status === 'failed');
    expect(fixture.store.getRun(record.id)).toMatchObject({
      status: RUN_STATUS.failed, error: expect.stringContaining('provider failed during shutdown'),
    });
  }, 30_000);
});

describe('RunManager check retry recovery', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('keeps a check retry budget bounded across a recovered workflow remainder', async () => {
    const workflow: WorkflowDef = {
      name: 'bounded-retry', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'verify', name: 'Verify', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'bounded retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'verify', name: 'Verify', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1, retriesUsed: 1 });
    setRunStatus(fixture.store, record.id, RUN_STATUS.queued, { workflowDef: workflow });

    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.pending });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(record.id) && FINISHED_RUN_STATUSES.has(fixture.store.getRun(record.id)!.status));

    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.failed });
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 2 }),
    ]));
  }, 30_000);

  it('does not spend a check retry merely because another loop executed it before', async () => {
    const workflow: WorkflowDef = {
      name: 'distinct-retry-budget', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'gate', name: 'Gate', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'distinct retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'gate', name: 'Gate', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'gate', { status: STEP_STATUS.done, iterations: 1 });
    setRunStatus(fixture.store, record.id, RUN_STATUS.queued, { workflowDef: workflow });

    const flushes: RunRecord[] = [];
    const originalFlush = fixture.store.flush.bind(fixture.store);
    vi.spyOn(fixture.store, 'flush').mockImplementation(() => {
      flushes.push(structuredClone(fixture.store.getRun(record.id)!));
      originalFlush();
    });
    fixture.store.updateStep(record.id, 'gate', { status: STEP_STATUS.pending });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(record.id) && FINISHED_RUN_STATUSES.has(fixture.store.getRun(record.id)!.status));

    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', iterations: 2 }),
      expect.objectContaining({ id: 'gate', status: STEP_STATUS.failed, iterations: 3, retriesUsed: 1 }),
    ]));
    expect(flushes.some(snapshot =>
      snapshot.status === 'queued' && snapshot.currentStepId === undefined &&
      snapshot.steps.some(step => step.id === 'task' && step.status === 'pending') &&
      snapshot.steps.some(step => step.id === 'gate' && step.status === 'pending' && step.retriesUsed === 1),
    )).toBe(true);
  }, 30_000);

  it('does not treat an unrelated failed check as a continuation workflow source', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    const workflow: WorkflowDef = {
      name: 'failed-check', source: 'file',
      steps: [
        SINGLE_STEP.steps[0]!,
        { id: 'verify', name: 'Verify', command: 'false' },
        { id: 'later', name: 'Later', command: 'true' },
      ],
    };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    setRunStatus(fixture.store, record.id, RUN_STATUS.failed, { currentStepId: undefined, workflowDef: workflow });

    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done inspect failure' })).toEqual({ ok: true });
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 1 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.pending, iterations: 0 }),
    ]));
  }, 30_000);

  it('restart reruns an interrupted check instead of completing it as a continuation source', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    fixture.manager.dispose();
    const workflow: WorkflowDef = { name: 'interrupted-check', source: 'file', steps: [
      SINGLE_STEP.steps[0]!,
      { id: 'verify', name: 'Verify', command: 'true' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.running, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    setRunStatus(fixture.store, record.id, RUN_STATUS.running, { currentStepId: 'verify', workflowDef: workflow });
    fixture.store.flush();

    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    await waitFor(record.id, candidate => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.done, iterations: 2 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done, iterations: 1 }),
    ]));
  }, 30_000);
});

describe('native /skill triggers survive a continuation (#811)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-811-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{
      id: 'probe-project', name: 'probe-project', scope: 'repo',
      path: join(repoRoot, '.agents/skills/probe-project/SKILL.md'),
    }]) });
    runId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const eventsOf = (id: string) =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  /** A finished run, ready for the cockpit's Reply composer. The dry-run mock ends its
   *  turn with no marker, so the run parks at `waiting` with the session open — closing
   *  it is what a user pressing Finish does, and `continueRun` only accepts a run that
   *  reached a terminal status. */
  const finishedRun = async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? '') && !manager.isActive(record.id));
    return record.id;
  };

  it("triggers a native skill in the continuation's opening turn", async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/probe-project look at the diff' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE')),
    );

    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE'),
    );
    expect(echoed?.text).toBe('TRIGGER-FIXTURE');
    expect(echoed?.text).not.toContain('/probe-project look at the diff');

    // Delivery-only: the transcript still shows what the user actually typed.
    const typed = eventsOf(id).find((e) => e.type === 'user-message' && e.stepId === 'continue-1');
    expect(typed?.text).toBe('/probe-project look at the diff');
  }, 40_000);

  it('triggers a native skill in a follow-up to the reopened session', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(id)?.status === 'waiting');

    expect(manager.sendMessage(id, [{ type: 'text', text: '/probe-project now review it' }])).toBe(true);
    await waitFor(() =>
      eventsOf(id).filter((e) => e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE')).length > 0,
    );
    expect(
      eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE')),
    ).toBe(true);
  }, 40_000);

  it('leaves an unknown slash command untouched so backend-native commands still work', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/compact please' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );
    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toContain('/compact please');
  }, 40_000);
});

describe("native /skill triggers on a fresh run's opening prompt (#87)", () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  let savedMockStdin: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-87-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    savedMockStdin = process.env.CEZ_MOCK_STDIN_FILE;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_STDIN_FILE = join(repoRoot, 'stdin.ndjson');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{
      id: 'probe-project', name: 'probe-project', scope: 'repo',
      path: join(repoRoot, '.agents/skills/probe-project/SKILL.md'),
    }]) });
    runId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedMockStdin === undefined) delete process.env.CEZ_MOCK_STDIN_FILE;
    else process.env.CEZ_MOCK_STDIN_FILE = savedMockStdin;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Tolerant of the pre-first-event window: the run's ndjson does not exist until
  // the engine writes its first event, and this describe polls events directly
  // (no store-status gate first), so a missing file is simply "no events yet".
  const eventsOf = (id: string) => {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8').trim();
    } catch {
      return [] as { type: string; text?: string; stepId?: string }[];
    }
    if (!raw) return [] as { type: string; text?: string; stepId?: string }[];
    return raw.split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });
  };

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  it('triggers the native skill in the opening turn', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: '/probe-project look at the diff',
      worktree: false,
    });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE'),
      ),
    );

    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('TRIGGER-FIXTURE'),
    );
    expect(echoed?.text).toBe('TRIGGER-FIXTURE');
    expect(echoed?.text).not.toContain('/probe-project look at the diff');
    expect(store.getRun(record.id)?.task).toBe('/probe-project look at the diff');
  }, 40_000);

  it.each([
    { task: '/compact please', registry: true },
    { task: '/probe-project look at the diff', registry: false },
  ])('passes through $task with registry=$registry', async ({ task, registry }) => {
    if (!registry) manager.setSkillCatalog(fixedSkillCatalog());
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    runId = record.id;
    await waitFor(() => eventsOf(record.id).some(e => e.stepId === 'task' && e.type === 'text'));
    // An unlisted command belongs to the runner, which may resolve it natively.
    // Assert Squawk's wire input rather than the runner's response to that command.
    const first = JSON.parse(readFileSync(join(repoRoot, 'stdin.ndjson'), 'utf8').trim().split('\n')[0]!);
    expect(first.userText).toBe(task);
    expect(store.getRun(record.id)?.task).toBe(task);
  }, 40_000);
});
