import type { RunnerMock } from '../../core/runner-definition.ts';
import { MOCK_BASELINE_PROMPT } from '../mock-prompts.ts';
import { FIXTURE_BIN_ENV } from './data.testkit.ts';

/**
 * The fixture runner's native mock (the `mock` part), laid out as a built-in runner's
 * `runners/<id>/mock.ts`. Data only. The scenarios the mock answers: those of the baseline seam rows the test runs. Every other scenario
 * is absent, so a row for it needs an exemption or a prompt before this runner can run it.
 */
export const FIXTURE_MOCK = {
  askResumeCases: [],
  binEnv: FIXTURE_BIN_ENV,
  script: 'mock-fixture-runner.mjs',
  scenarios: {
    baseline: MOCK_BASELINE_PROMPT,
    'missing-binary': MOCK_BASELINE_PROMPT,
    hold: 'mock:hold',
    'provider-error': 'mock:provider-error',
  },
  // The reasons the parity kit requires by this runner's facts: A9 for no answerable native ask, and
  // U12, U13 and U27 for an acknowledgement that is the local write (`runner-facts.test.ts`).
  parityExemptions: {
    A9: {
      kind: 'scenario-unconstructible',
      reason: 'The fixture mock answers no ask scenario and its wire has no native ask, so no native mid-turn ask.requested can arise.',
    },
    U12: {
      kind: 'capability-absent',
      reason: 'The fixture adapter resolves agent input once its stdin line is written; no provider stands between, so nothing can hold that acknowledgement back.',
    },
    U13: {
      kind: 'capability-absent',
      reason: 'The fixture adapter resolves agent input once its stdin line is written, and a written line gets no refusal from the mock.',
    },
    U27: {
      kind: 'capability-absent',
      reason: 'The fixture adapter resolves agent input once its stdin line is written, before the mock starts the turn, so no turn ends with its input unacknowledged.',
    },
  },
} as const satisfies RunnerMock;
