import { expect, it, vi } from 'vitest';
import { unused } from '../unused.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { FamilyReconciler } from './family-reconciler.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

// hearsay-tools/squawk#3909: restart recovery fails an interrupted turn, then continues the task.
// The `failed` record it writes in between must not reap the scratch the continued task still uses;
// a live restart lost the task temp directory this way. The reap waits for recovery to end and
// then reads the run again.
type Host = ConstructorParameters<typeof FamilyReconciler>[1];

function reconcilerFixture() {
  const f = boundaryOrderFixture();
  const reap = vi.fn();
  let recovering = true;
  const waitEngine = { cancelAll: () => undefined, resolvePeerWaits: () => undefined } as unknown as Host['waitEngine'];
  const reconciler = new FamilyReconciler(f.context, unused<Host>('family host', {
    reapTerminalScratch: reap, waitEngine, active: () => undefined, recoveringRun: () => recovering,
  }));
  const failed = { ...f.store.getRun(f.run.id)!, status: RUN_STATUS.failed };
  return { reconciler, reap, failed, endRecovery: () => { recovering = false; } };
}

it('defers the scratch reap of a run that recovery holds, then reaps it once after recovery', () => {
  const { reconciler, reap, failed, endRecovery } = reconcilerFixture();
  reconciler.onDelegationRun(failed);
  reconciler.onDelegationRun(failed);
  expect(reap).not.toHaveBeenCalled();
  endRecovery();
  reconciler.reapDeferredScratch();
  reconciler.reapDeferredScratch();
  expect(reap.mock.calls).toEqual([[failed.id]]);
  reconciler.dispose();
});

it('reaps at once outside recovery', () => {
  const { reconciler, reap, failed, endRecovery } = reconcilerFixture();
  endRecovery();
  reconciler.onDelegationRun(failed);
  expect(reap.mock.calls).toEqual([[failed.id]]);
  reconciler.dispose();
});
