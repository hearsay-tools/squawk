import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { closedCells } from './waits-parity-closed-cells.testkit.ts';
import { completionCells } from './waits-parity-completion-cells.testkit.ts';
import { completionRepliesCells } from './waits-parity-completion-replies-cells.testkit.ts';
import { conversationsCells } from './waits-parity-conversations-cells.testkit.ts';
import { deliveryCells } from './waits-parity-delivery-cells.testkit.ts';
import { mixedCells } from './waits-parity-mixed-cells.testkit.ts';
import { recoveryCells } from './waits-parity-recovery-cells.testkit.ts';
import { refusalCells } from './waits-parity-refusal-cells.testkit.ts';

// The every-runner rows of the delivery and worker wait fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = waitFoldDescriber('workers', {
  delivery: deliveryCells,
  mixed: mixedCells,
  recovery: recoveryCells,
  conversations: conversationsCells,
  refusal: refusalCells,
  completion: completionCells,
  'completion-replies': completionRepliesCells,
  closed: closedCells,
});
