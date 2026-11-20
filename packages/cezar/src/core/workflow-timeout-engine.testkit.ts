import { expect } from 'vitest';
import { waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';
import { setWorkflowTimeoutEngineCell } from './workflow-timeout-parity.testkit.ts';
import type { WorkflowTimeoutCell } from './workflow-timeout-rows.testkit.ts';
import { workflowDefSchema } from '../workflows/types.ts';

// The workflow-timeout rows that run a workflow through RunManager (T1, T2, T3, T5, T6).
// The seam rows T4 and T7 live in workflow-timeout-parity.testkit.ts.

const engineCell: WorkflowTimeoutCell = (backend, criterion) => async () => {
  if (criterion.id === 'T6') {
    await withOwnedInputRun(backend, criterion.scenario, async ({ store, manager, runId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => ['waiting', 'failed'].includes(store.getRun(runId)?.status ?? ''));
      expect(store.getRun(runId)?.status).toBe('waiting');
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.error).toBeUndefined();
    }, { timings: { runTimeoutMs: 150 } });
    return;
  }
  const workflowDef = workflowDefSchema.parse({ name: 'deadline-test', source: 'file', steps: [
    { id: 'implement', prompt: '{{task}}',
      ...(criterion.id === 'T2' ? { timeoutMs: 0 } : criterion.id === 'T3' ? { timeoutMs: 150 } : criterion.id === 'T5' ? { timeoutMs: 15_000 } : {}) },
    { id: 'verify', command: 'test -f a.txt' },
  ] });
  await withOwnedInputRun(backend, criterion.scenario, async ({ store, manager, runId }) => {
    manager.enqueueOwnedRun(runId);
    await waitFor(() => ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? ''));
    await waitFor(() => !manager.isActive(runId));
    const run = store.getRun(runId)!;
    if (criterion.id === 'T3') {
      expect(run.status).toBe('failed');
      expect(run.error).toContain('timed out');
      expect(run.steps[0]?.status).toBe('failed');
      expect(store.readEvents(runId).some(e => e.type === 'check-output')).toBe(false);
    } else {
      expect(run.error).toBeUndefined();
      expect(run.steps.map(s => s.status)).toEqual(['done', 'done']);
      expect(store.readEvents(runId).filter(e => e.type === 'check-output')).toMatchObject([
        { stepId: 'verify', exitCode: 0 },
      ]);
    }
  }, { workflowDef, timings: { runTimeoutMs: 150 } });
};

/** An engine part file calls this before `describeWorkflowTimeoutParity`. */
export function installWorkflowTimeoutEngine(): void {
  setWorkflowTimeoutEngineCell(engineCell);
}
