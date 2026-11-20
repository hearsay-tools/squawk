import { parityRunners } from '../core/parity-classes.testkit.ts';

/** The ci-wait-conflict parity rows: which runners each mode's file group registers. Apart from the
 *  cells, so the registration guard reads them without loading the run engine. */
export const CONFLICT_ROWS = { fresh: 'R81', continued: 'R82', recovered: 'R83' } as const;
export const GROUPS = { fresh: parityRunners('ci-wait-conflict', 'R81'), continued: parityRunners('ci-wait-conflict', 'R82'), recovered: parityRunners('ci-wait-conflict', 'R83') };
