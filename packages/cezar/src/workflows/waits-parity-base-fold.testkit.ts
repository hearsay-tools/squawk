import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { answersCells } from './waits-parity-answers-cells.testkit.ts';
import { asksCells } from './waits-parity-asks-cells.testkit.ts';
import { deadlineCells } from './waits-parity-deadlines-cells.testkit.ts';
import { doneCells } from './waits-parity-done-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';
import { processCells } from './waits-parity-process-cells.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';

// The every-runner rows of the base wait fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = waitFoldDescriber('base', {
  registration: registrationCells,
  input: inputCells,
  asks: asksCells,
  done: doneCells,
  answers: answersCells,
  process: processCells,
  deadlines: deadlineCells,
});
