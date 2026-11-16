import { fakeRunnerFactory } from '../core/fake-runner-factory.testkit.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { removedRunnerMessage } from '@open-mercato/cezar-contract/runner';
import { createFixtureManager, drainFixtureManagers } from './fixture-manager.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunManager } from './run.ts';

// hearsay-tools/squawk#3715: a run saved on a runner Squawk no longer ships continues only on a
// runner the Continue names, in a new session.
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], release: undefined as (() => void) | undefined,
  started: undefined as ((spec: AgentRunSpec) => void) | undefined }));
useRunners(fakeRunnerFactory(() => ({
  backend: 'codex', systemPromptOnResume: 'in-thread' as const, interrupt: async () => {},
  startSession: (spec: AgentRunSpec) => {
    captured.specs.push(spec);
    captured.started?.(spec);
    return { result: new Promise(resolve => { captured.release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }); }),
      sendMessage: () => true, discardQueuedMessages: () => {}, holdsHumanInput: () => false, end: () => {}, interrupt: () => {}, open: true };
  },
})));

const roots: string[] = [];
const managers: RunManager[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-removed-runner-')); roots.push(root);
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } }) });
  managers.push(manager);
  return { store, manager };
}

/** A finished run as the store reads one saved on a removed runner: marked, with no session. */
function removedRunnerRun(store: RunStore) {
  const run = store.createRun({ title: 'task', task: 'task', workflow: 'original',
    steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
  store.updateStep(run.id, 'work', { status: STEP_STATUS.done });
  store.updateRun(run.id, { removedRunner: 'cursor' });
  setRunStatus(store, run.id, RUN_STATUS.done);
  return run;
}

afterEach(async () => {
  captured.release?.(); captured.release = undefined;
  for (const root of roots) await drainFixtureManagers(root);
  managers.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  captured.specs.length = 0;
  captured.started = undefined;
});

describe('Continue on a run saved on a removed runner', () => {
  it.each([
    { name: 'a human Continue', defer: false },
    { name: 'a wake or restart recovery', defer: true },
  ])('refuses $name that names no runner', ({ defer }) => {
    const { store, manager } = fixture();
    const run = removedRunnerRun(store);

    expect(manager.continueRun(run.id, { text: 'keep going' }, defer)).toEqual({ ok: false, error: removedRunnerMessage('cursor') });
    expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.done);
  });

  it('starts a new session on the runner the Continue names, and stops being a removed-runner run', async () => {
    const { store, manager } = fixture();
    const run = removedRunnerRun(store);

    const started = new Promise<AgentRunSpec>(resolve => { captured.started = resolve; });
    expect(manager.continueRun(run.id, { text: 'keep going', runner: 'codex' })).toEqual({ ok: true });

    expect((await started).resume).toBeFalsy();
    expect(store.getRun(run.id)).toMatchObject({ runner: 'codex' });
    expect(store.getRun(run.id)?.removedRunner).toBeUndefined();
  });
});
