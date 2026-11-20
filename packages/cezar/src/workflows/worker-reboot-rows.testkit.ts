import { parityRunners } from '../core/parity-classes.testkit.ts';

// A shared family (core/parity-classes.testkit.ts): seam row S43 holds each runner to reporting the
// native processes the ledger records, and runner-shutdown to stopping them.
const runners = parityRunners('worker-reboot', 'R43');
/** The worker-reboot file groups. Apart from the cells, so the registration guard reads them without
 *  loading the run engine. */
export const GROUPS = { collect: runners, destroy: runners, reuse: runners };
