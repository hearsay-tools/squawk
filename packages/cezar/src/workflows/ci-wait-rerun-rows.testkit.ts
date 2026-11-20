import { parityRunners } from '../core/parity-classes.testkit.ts';

/** The ci-wait-rerun parity rows: which runners each file group registers. Apart from the cells
 *  and their timer mock, so the registration guard reads them without loading the run engine. */
export const GROUPS = { fresh: parityRunners('ci-wait-rerun', 'R85'), recovered: parityRunners('ci-wait-rerun', 'R85') };
