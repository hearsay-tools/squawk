import { describe, expect, it } from 'vitest';
import * as agentInput from './agent-input.ts';
import * as delegation from './delegation.ts';
import * as waitLimits from './wait-limits.ts';
import * as waitingOn from './waiting-on.ts';
import * as waits from './waits.ts';
import * as workerOutcome from './worker-outcome.ts';

/**
 * hearsay-tools/squawk#3245 moved values out of `delegation.ts` and `waits.ts` into small modules.
 * Readers outside Squawk still import them from the old modules, so those re-export each moved
 * value as the same binding.
 */
describe('the modules split from delegation.ts and waits.ts', () => {
  // Named keys: the title formats only the file names, never a module namespace.
  it.each([
    { old: 'delegation.ts', moved: 'agent-input.ts', oldModule: delegation, movedModule: agentInput },
    { old: 'delegation.ts', moved: 'worker-outcome.ts', oldModule: delegation, movedModule: workerOutcome },
    { old: 'waits.ts', moved: 'wait-limits.ts', oldModule: waits, movedModule: waitLimits },
    { old: 'waits.ts', moved: 'waiting-on.ts', oldModule: waits, movedModule: waitingOn },
  ])('$old re-exports every value of $moved', ({ oldModule, movedModule }) => {
    expect(Object.keys(movedModule).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(movedModule)) expect((oldModule as Record<string, unknown>)[name], name).toBe(value);
  });
});
