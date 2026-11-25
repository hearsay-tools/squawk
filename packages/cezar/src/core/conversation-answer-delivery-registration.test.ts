import './register-all-runners.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { registrationCollector, registrationCalls } from './split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { ANSWER_DELIVERY_GROUPS, answerDeliveryCellNames } from './conversation-answer-delivery-rows.testkit.ts';

it('registers every conversation-answer-delivery row exactly once', () => {
  const names: string[] = [];
  const collect = registrationCollector(names);
  for (const rows of Object.values(ANSWER_DELIVERY_GROUPS)) for (const row of rows) answerDeliveryCellNames[row.family](row.runner, collect);
  const actual = names.map(name => { const match = name.match(/^(\S+) (?:is exempt from )?(I\d+)/)!; return `${match[1]}:${match[2]}`; });
  const expected = BUILT_IN_RUNNER_IDS.flatMap(runner => ['I3', 'I4', 'I5'].map(row => `${runner}:${row}`));
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'conversation-answer-delivery-', 'registerAnswerDeliveryGroup');
  expect(calls.sort()).toEqual(Object.keys(ANSWER_DELIVERY_GROUPS).sort());
});
