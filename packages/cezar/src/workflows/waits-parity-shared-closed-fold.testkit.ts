import { sharedWaitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { closedCells } from './waits-parity-closed-cells.testkit.ts';
import { entriesCells } from './waits-parity-entries-cells.testkit.ts';

// Shared wait cells of the closed fold (`SHARED_WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = sharedWaitFoldDescriber('closed', {
  closed: closedCells,
  entries: entriesCells,
});
