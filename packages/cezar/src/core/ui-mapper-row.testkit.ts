import type { UiEvent } from './ui-events.ts';

/** One runner's mapper with its state type erased, so one loop can drive all of them
 *  (`ui-mapper-robustness.test.ts`). */
export interface Mapper {
  /** The state the runner holds when the first wire frame arrives. */
  seed(): object;
  map(frame: unknown, state: object): unknown;
}

export function mapper<S extends object>(
  seed: () => S,
  map: (frame: unknown, state: S) => { events: UiEvent[]; state: S },
): Mapper {
  return { seed, map: (frame, state) => map(frame, state as S) };
}
