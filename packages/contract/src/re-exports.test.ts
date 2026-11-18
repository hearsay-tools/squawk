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
  it.each([
    ['delegation.ts', delegation, 'agent-input.ts', agentInput],
    ['delegation.ts', delegation, 'worker-outcome.ts', workerOutcome],
    ['waits.ts', waits, 'wait-limits.ts', waitLimits],
    ['waits.ts', waits, 'waiting-on.ts', waitingOn],
  ] as const)('%s re-exports every value of %s', (_old, oldModule, _moved, movedModule) => {
    expect(Object.keys(movedModule).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(movedModule)) expect((oldModule as Record<string, unknown>)[name], name).toBe(value);
  });
});
