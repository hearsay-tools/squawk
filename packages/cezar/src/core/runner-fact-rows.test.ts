import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { factRows } from './runner-fact-rows.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

it('reads the same facts objects as the registered definitions, in RUNNER_IDS order', () => {
  expect(Object.keys(factRows())).toEqual([...RUNNER_IDS]);
  for (const id of RUNNER_IDS) expect(factRows()[id], id).toBe(runnerDefinition(id).facts);
});
