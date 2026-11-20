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
  // The parity kit requires an A9 reason from every runner whose facts declare no answerable native ask.
  parityExemptions: {
    A9: {
      kind: 'scenario-unconstructible',
      reason: 'The fixture mock answers no ask scenario and its wire has no native ask, so no native mid-turn ask.requested can arise.',
    },
  },
} as const satisfies RunnerMock;
