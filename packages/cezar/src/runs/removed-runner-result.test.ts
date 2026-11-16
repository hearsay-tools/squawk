import { describe, expect, it } from 'vitest';
import { upgradeRemovedRunnerResult } from './legacy-run-rows.ts';

// hearsay-tools/squawk#3715: a collected result of a worker that ran on a removed runner stays readable.
describe('upgradeRemovedRunnerResult', () => {
  it('drops a removed runner from a saved worker result and keeps every other field', () => {
    const file = { result: { workerId: 'w', backend: 'cursor', model: 'auto' }, diffSnapshot: 'diff' };
    upgradeRemovedRunnerResult(file);
    expect(file).toEqual({ result: { workerId: 'w', model: 'auto' }, diffSnapshot: 'diff' });
  });

  it('leaves a live runner and malformed input untouched', () => {
    const live = { result: { backend: 'codex' } };
    upgradeRemovedRunnerResult(live);
    expect(live).toEqual({ result: { backend: 'codex' } });
    expect(() => upgradeRemovedRunnerResult(null)).not.toThrow();
    expect(() => upgradeRemovedRunnerResult({ result: 'x' })).not.toThrow();
  });
});
