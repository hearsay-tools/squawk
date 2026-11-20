import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The pi runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const PI_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_PI_BIN',
  script: 'mock-pi-rpc.mjs',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...STDIO_ASK_MOCK_SCENARIOS,
    ...PROVIDER_ERROR_MOCK_SCENARIOS,
    'provider-unavailable': 'mock:provider-unavailable',
    // No `subagent`: see the S9 and R12 entries in PARITY_EXEMPTIONS.
  },
} as const satisfies RunnerMock;
