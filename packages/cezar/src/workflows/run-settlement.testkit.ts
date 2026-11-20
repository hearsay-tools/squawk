import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunStore } from '../runs/store.ts';

/** Engine-free seed for the success-settlement tests: the module tests and the engine tests share it. */
export const oldFinish = '2026-07-01T12:00:00.000Z';
export const liveStatuses = ['waiting', 'running'] as const;
export const preservedStatuses = ['done', 'failed', 'cancelled', 'skipped', 'pending'] as const;

/** A waiting run with one step per live and preserved status, each with and without a finish time.
 *  A durable run is a root with its finish intent committed. */
export function seedSettlementRun(store: RunStore, root: string, durable: boolean): string {
  const record = store.createRun({ title: 'settlement', task: 'finish', workflow: 'quick-task', workflowDef: { name: 'quick-task', source: 'file', steps: [{ id: 'waiting-false', prompt: 'work' }] }, steps: [] });
  for (const status of [...liveStatuses, ...preservedStatuses]) {
    for (const stamped of [false, true]) {
      const id = `${status}-${stamped}`;
      store.addStep(record.id, { id, name: id, kind: STEP_KIND.agent, synthetic: 'continuation' });
      store.updateStep(record.id, id, { status, startedAt: oldFinish, ...(stamped ? { finishedAt: oldFinish } : {}) });
    }
  }
  setRunStatus(store, record.id, RUN_STATUS.waiting, { currentStepId: 'waiting-false', worktreePath: root,
    ...(durable ? { delegation: { role: 'root' as const, permissions: [], receipts: [] } } : {}),
  });
  store.updateStep(record.id, 'waiting-false', { sessionId: 'seed-session', backend: 'claude' });
  if (durable) store.commitRootFinishIntent(record.id);
  return record.id;
}
