import { sharedWaitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { answersCells } from './waits-parity-answers-cells.testkit.ts';
import { deadlineCells } from './waits-parity-deadlines-cells.testkit.ts';
import { doneCells } from './waits-parity-done-cells.testkit.ts';
import { processCells } from './waits-parity-process-cells.testkit.ts';

// Shared wait cells of the outcomes fold (`SHARED_WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = sharedWaitFoldDescriber('outcomes', {
  done: doneCells,
  answers: answersCells,
  process: processCells,
  deadlines: deadlineCells,
});
