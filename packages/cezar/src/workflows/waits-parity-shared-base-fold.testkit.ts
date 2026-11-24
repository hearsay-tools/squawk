import { sharedWaitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { asksCells } from './waits-parity-asks-cells.testkit.ts';
import { deliveryCells } from './waits-parity-delivery-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';

// Shared wait cells of the base fold (`SHARED_WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`).
export const describeWaitParity = sharedWaitFoldDescriber('base', {
  registration: registrationCells,
  input: inputCells,
  delivery: deliveryCells,
  asks: asksCells,
});
