import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';

import { defineRunner } from '../../core/runner-definition.ts';
import { registerRunner } from '../../core/runner-registry.ts';
import { codexRunner } from '../../runners/codex/definition.ts';
import { RunStore } from '../../runs/store.ts';
import { createActiveRun } from '../active-run.ts';
import { beginUsageInvocation, recordReportedCost } from './usage-accounting.ts';

// C1 review B2 (hearsay-tools/squawk#3936): a registered runner that is no built-in reads its own
// declared cost report, also when a new process restores a cumulative session's baseline.
registerRunner(defineRunner({ ...codexRunner, id: 'custom-cumulative', facts: { ...codexRunner.facts, costReport: 'cumulative' } }));
registerRunner(defineRunner({ ...codexRunner, id: 'custom-per-turn', facts: { ...codexRunner.facts, costReport: 'per-turn' } }));

let root: string;
let store: RunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-cost-custom-'));
  store = RunStore.open(join(root, '.ai/cezar'));
});
afterEach(() => { store.persistence.flush(); rmSync(root, { recursive: true, force: true }); });

function report(runId: string, stepId: string, state: ReturnType<typeof createActiveRun>, backend: string, usd: number) {
  store.eventLog.appendEvent(runId, { type: 'cost', stepId, usd });
  recordReportedCost(store, runId, stepId, state, backend, usd);
}

it.each([
  ['custom-cumulative', 3],
  ['custom-per-turn', 4],
] as const)('turns reports of 1 then 3 from the registered custom runner %s into a step cost of %s', (backend, total) => {
  const run = store.createRun({ title: 'cost', task: 'cost', workflow: 'quick-task', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
  store.updateStep(run.id, 'work', { backend, sessionId: 'session-1' });
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  beginUsageInvocation(store, run.id, state, 'work');
  report(run.id, 'work', state, backend, 1);
  report(run.id, 'work', state, backend, 3);
  expect(store.getRun(run.id)!.steps[0]!.costUsd).toBe(total);
});

it('restores a registered custom runner\'s cumulative session baseline after a restart', () => {
  const run = store.createRun({ title: 'cost', task: 'cost', workflow: 'quick-task', steps: [
    { id: 'work', name: 'Work', kind: STEP_KIND.agent },
    { id: 'continue', name: 'Continue', kind: STEP_KIND.agent },
  ] });
  store.updateStep(run.id, 'work', { backend: 'custom-cumulative', sessionId: 'session-1' });
  store.updateStep(run.id, 'continue', { backend: 'custom-cumulative', sessionId: 'session-1' });
  const first = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  beginUsageInvocation(store, run.id, first, 'work');
  report(run.id, 'work', first, 'custom-cumulative', 2);
  // A new process holds no cost checkpoint: the Continue step's report of 5 adds only 3.
  const second = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  beginUsageInvocation(store, run.id, second, 'continue');
  report(run.id, 'continue', second, 'custom-cumulative', 5);
  expect(store.getRun(run.id)!.steps.map(step => step.costUsd)).toEqual([2, 3]);
});
