import { sharedWaitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { conversationsCells } from './waits-parity-conversations-cells.testkit.ts';
import { mixedCells } from './waits-parity-mixed-cells.testkit.ts';
import { recoveryCells } from './waits-parity-recovery-cells.testkit.ts';
import { refusalCells } from './waits-parity-refusal-cells.testkit.ts';

// Shared wait cells of the workers fold (`SHARED_WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = sharedWaitFoldDescriber('workers', {
  mixed: mixedCells,
  recovery: recoveryCells,
  conversations: conversationsCells,
  refusal: refusalCells,
});
