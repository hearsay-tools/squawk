import type { RunnerMock } from '../../core/runner-definition.ts';
import { MOCK_BASELINE_PROMPT, COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The omp runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const OMP_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_OMP_BIN',
  script: 'mock-omp-rpc.mjs',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...STDIO_ASK_MOCK_SCENARIOS,
    ...PROVIDER_ERROR_MOCK_SCENARIOS,
    'closed-input': 'mock:closed-input',
    'auto-resumed': MOCK_BASELINE_PROMPT,
    'provider-unavailable': 'mock:provider-unavailable',
    subagent: 'mock:subagent',
    'subagent-after-park': 'mock:subagent-after-park',
  },
} as const satisfies RunnerMock;
