import '../core/register-all-runners.testkit.ts';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { extraToolRows, factRows } from './runner-fact-rows.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';


it('reads the same facts objects as the registered definitions, in RUNNER_IDS order', () => {
  expect(Object.keys(factRows())).toEqual([...RUNNER_IDS]);
  for (const id of RUNNER_IDS) expect(factRows()[id], id).toBe(runnerDefinition(id).facts);
});

it('reads the same extraTools as the registered definitions, in RUNNER_IDS order', () => {
  expect(Object.keys(extraToolRows())).toEqual([...RUNNER_IDS]);
  for (const id of RUNNER_IDS) expect(extraToolRows()[id], id).toBe(runnerDefinition(id).extraTools);
});
