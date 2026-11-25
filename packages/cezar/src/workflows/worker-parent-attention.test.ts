import { BUILT_IN_RUNNER_IDS } from '../core/built-in-runner-ids.testkit.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SCENARIO_RUNNER } from '../core/parity-classes.testkit.ts';
import { ACK_WIRES, ATTENTION_GROUPS, attentionRowKey } from './worker-parent-attention-rows.testkit.ts';

it('classifies every BUILT_IN_RUNNER_IDS delayed-ACK cell without omissions', () => {
  expect(Object.keys(ACK_WIRES).sort()).toEqual([...BUILT_IN_RUNNER_IDS].sort());
});
it('registers every attention runner/mode/transport row exactly once', () => {
 const expected = [
  ...BUILT_IN_RUNNER_IDS.flatMap(backend => ['fresh', 'continuation'].map(mode => `${backend}:progress:${mode}:${ACK_WIRES[backend]}`)),
  ...['fresh', 'continuation'].map(mode => `${SCENARIO_RUNNER}:progress:${mode}:ordinary`),
  ...['fresh', 'continuation'].map(mode => `${SCENARIO_RUNNER}:spawn-ask:${mode}`),
  ...['completion', 'timeout', 'restart', 'human-ask'].map(family => `${SCENARIO_RUNNER}:${family}`),
 ];
 expect(Object.values(ATTENTION_GROUPS).flat().map(attentionRowKey).sort()).toEqual(expected.sort());
 const calls = readdirSync(new URL('.', import.meta.url)).filter(file => /^worker-parent-attention-.*\.test\.ts$/.test(file))
  .flatMap(file => { return [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/registerAttentionGroup\('([^']+)'\)/g)].map(match => match[1]); });
 expect(calls.sort()).toEqual(Object.keys(ATTENTION_GROUPS).sort());
});
