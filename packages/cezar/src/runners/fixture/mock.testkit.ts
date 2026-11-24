import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS } from '../mock-prompts.ts';
import { FIXTURE_BIN_ENV } from './data.testkit.ts';

/**
 * The fixture runner's native mock (the `mock` part), laid out as a built-in runner's
 * `runners/<id>/mock.ts`. Data only. Supports every shared scenario so runner-agnostic engine
 * tests run once on `runners/fixture/` without touching built-in adapters.
 */
export const FIXTURE_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: FIXTURE_BIN_ENV,
  script: 'mock-fixture-runner.mjs',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...STDIO_ASK_MOCK_SCENARIOS,
    'provider-error': 'mock:provider-error',
    'provider-error-controlled': 'mock:auth-error',
    'steer-late': 'mock:hold',
  },
  // The reasons the parity kit requires by this runner's facts: A9 for no answerable native ask,
  // R77/UI2 for no hook frames, and U12/U13/U27 for an acknowledgement that is the local write.
  parityExemptions: {
    A9: {
      kind: 'capability-absent',
      reason: 'The fixture mock asks through cezar_ask and emits no native mid-turn ask.requested.',
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
    R77: {
      kind: 'scenario-unconstructible',
      reason: 'The fixture mock emits no hook lifecycle frame, so no hook item can arrive after a park.',
    },
    UI2: {
      kind: 'capability-absent',
      reason: 'The fixture mock emits no hook event.',
    },
  },
} as const satisfies RunnerMock;
