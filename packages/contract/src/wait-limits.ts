/**
 * The bounds of the wait list in `waits.ts`. Many Squawk modules read only these numbers, so they
 * live in a module with no runtime imports; `waits.ts` re-exports them (hearsay-tools/squawk#3245).
 */

export const WAIT_LIMIT = 16;
export const LAST_WAITS_LIMIT = 16;
export const TIMER_MIN_SECONDS = 60;
export const TIMER_MAX_SECONDS = 7200;
/** A process wait's bounds (hearsay-tools/cezarion#1446): the CI wait's timeout range. */
export const PROCESS_TIMEOUT_DEFAULT_SECONDS = 1800;
export const PROCESS_TIMEOUT_MAX_SECONDS = 7200;
export const PROCESS_EXIT_FILE_MAX = 4096;
/** A peer wait's deadline, and a request or worker wait's (hearsay-tools/cezarion#1995). */
export const PEER_WAIT_DEFAULT_SECONDS = 600;
export const PEER_WAIT_MAX_SECONDS = 7200;
/** A subagent wait (hearsay-tools/cezarion#2431): its safety deadline after the last child event,
 *  the grace after the last child ends before Squawk wakes the parent, and its child bound. */
export const SUBAGENT_WAIT_DEADLINE_SECONDS = 1800;
export const SUBAGENT_WAIT_GRACE_SECONDS = 15;
export const SUBAGENT_WAIT_CHILD_LIMIT = 32;
/** The bound on every wait and done refusal's `message`; the run manager fits its own to it. */
export const WAIT_MESSAGE_MAX = 4096;
