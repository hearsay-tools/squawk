import { workerOutcomeSchema } from './worker-outcome.ts';
import type { RunEvent } from './events.ts';
import { runStatusSchema, stepKindSchema, stepStatusSchema } from './run-status.ts';
import type { RunRecord, StepState } from './runs.ts';

/**
 * Typed test data for run records and events (hearsay-tools/cezarion#1812); the waits are in
 * `wait-factories.testkit.ts` (hearsay-tools/squawk#4143). A test builds its
 * data here and names an enum value through a constant, so a renamed `RunRecord` field or a renamed
 * wait kind stops compiling in every test that uses it, instead of staying a literal that still
 * compiles and asserts the old value (hearsay-tools/cezarion#1300, hearsay-tools/cezarion#1504).
 *
 * Tests only: nothing in a build reaches this file, and it imports no Node module, so the cockpit's
 * tests can use it too, through `@open-mercato/cezar-api-client/contract/test-factories.testkit`.
 * The `cez/test-enum-literal` oxlint AST rule fails a new enum literal in a test.
 *
 * Each factory returns a value the contract's own schema accepts, which `test-factories.test.ts`
 * proves with `parse`. The overrides are `Partial` of the contract type, so a fresh object literal
 * naming a field the type lacks is a compile error. Events are the exception: the contract keeps
 * them open (an append-only on-disk vocabulary), so only the keys it names are checked.
 */

// ---- enum constants -----------------------------------------------------------------------

// Each constant is the schema's own value list, never a copy: a value the contract renames is a
// compile error at its uses, and one it adds is here already. The wait constants live in
// `wait-factories.testkit.ts`.
export const RUN_STATUS = runStatusSchema.enum;
export const STEP_STATUS = stepStatusSchema.enum;
export const STEP_KIND = stepKindSchema.enum;
// A worker's outcome inside a delegation or a worker wait: its own enum, a subset of the run statuses.
export const WORKER_OUTCOME_STATUS = workerOutcomeSchema.shape.status.enum;

// ---- shared defaults ----------------------------------------------------------------------

export const NOW = '2026-10-26T00:00:00.000Z';

let sequence = 0;
/** The one counter every factory draws from, here and in `wait-factories.testkit.ts`. */
export const next = (): number => (sequence += 1);

// ---- run records --------------------------------------------------------------------------

/** One step of a run's chain: a finished agent step unless the test says otherwise. */
export function makeStepState(over: Partial<StepState> = {}): StepState {
  return {
    id: 'task',
    name: 'Do the task',
    kind: STEP_KIND.agent,
    status: STEP_STATUS.done,
    iterations: 1,
    tokensUsed: 0,
    ...over,
  };
}

/** A finished run with no steps and its own id: the fields the contract requires, and nothing else. */
export function makeRunRecord(over: Partial<RunRecord> = {}): RunRecord {
  const n = next();
  return {
    id: `run-${n}`,
    title: `Task ${n}`,
    workflow: 'quick-task',
    task: `task ${n}`,
    status: RUN_STATUS.done,
    createdAt: NOW,
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  };
}

// ---- events -------------------------------------------------------------------------------

/** A transcript line. Any key beyond `seq`, `ts` and `type` rides along, as the open format allows. */
export function makeRunEvent(over: Pick<RunEvent, 'type'> & Partial<RunEvent>): RunEvent {
  return { seq: next(), ts: NOW, ...over };
}

