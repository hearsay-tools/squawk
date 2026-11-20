import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import '../core/register-all-runners.testkit.ts';
import { expect, it } from 'vitest';
import { extraToolRows, factRows } from './runner-fact-rows.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';


it('reads the same facts objects as the registered definitions, in BUILT_IN_RUNNER_IDS order', () => {
  expect(Object.keys(factRows())).toEqual([...BUILT_IN_RUNNER_IDS]);
  for (const id of BUILT_IN_RUNNER_IDS) expect(factRows()[id], id).toBe(runnerDefinition(id).facts);
});

it('reads the same extraTools as the registered definitions, in BUILT_IN_RUNNER_IDS order', () => {
  expect(Object.keys(extraToolRows())).toEqual([...BUILT_IN_RUNNER_IDS]);
  for (const id of BUILT_IN_RUNNER_IDS) expect(extraToolRows()[id], id).toBe(runnerDefinition(id).extraTools);
});
