import { sharedWaitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { completionCells } from './waits-parity-completion-cells.testkit.ts';
import { completionRepliesCells } from './waits-parity-completion-replies-cells.testkit.ts';

// Shared wait cells of the completion fold (`SHARED_WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = sharedWaitFoldDescriber('completion', {
  completion: completionCells,
  'completion-replies': completionRepliesCells,
});
