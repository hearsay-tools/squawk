import { workflowTimeoutParity, type WorkflowTimeoutCell } from './workflow-timeout-rows.testkit.ts';
import { expect } from 'vitest';
import { driveSeam } from './harness-parity.testkit.ts';

// Compress only the deadline, not the runner, manager, clock or native wire.
// Every adapter's hold scenario lasts at least 500ms. The unfixed manager
// leaves the default enabled and kills that non-final step before its check.

// T4 and T7 drive each runner at its seam and load no engine. The other rows run a workflow
// through RunManager: their part files call installWorkflowTimeoutEngine()
// (workflow-timeout-engine.testkit.ts) before they register, so a seam part file never imports run.ts.
let engineCell: WorkflowTimeoutCell | undefined;

/** Called by `workflow-timeout-engine.testkit.ts` only. */
export function setWorkflowTimeoutEngineCell(cell: WorkflowTimeoutCell): void {
  engineCell = cell;
}

const seamCell: WorkflowTimeoutCell = (backend, criterion) => async () => {
  if (criterion.id === 'T7') {
    // The runner owns how it applies the deadline Squawk passes: zero means none, a longer limit
    // outlives its own default (injected as 150 ms; every hold lasts 500 ms), and a
    // shorter one ends the turn with a timed-out error.
    for (const timeoutMs of [0, 15_000]) {
      const observed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs, timings: { runTimeoutMs: 150 } } });
      expect(observed.v1.filter(e => e.type === 'error'), `timeoutMs ${timeoutMs}`).toEqual([]);
      expect(observed.v1.some(e => e.type === 'turn-end'), `timeoutMs ${timeoutMs}`).toBe(true);
    }
    const killed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs: 100, timings: { runTimeoutMs: 150 } } });
    expect(killed.v1.some(e => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
    return;
  }
  const observed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs: undefined, timings: { runTimeoutMs: 150 } } });
  expect(observed.v1.some(e => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
};

const engineRow: WorkflowTimeoutCell = (backend, criterion) => () => {
  if (!engineCell) throw new Error(`${backend} ${criterion.id} runs on the engine: call installWorkflowTimeoutEngine() before describeWorkflowTimeoutParity`);
  return engineCell(backend, criterion)();
};

export const describeWorkflowTimeoutParity = workflowTimeoutParity((backend, criterion) =>
  (criterion.id === 'T4' || criterion.id === 'T7' ? seamCell : engineRow)(backend, criterion));
