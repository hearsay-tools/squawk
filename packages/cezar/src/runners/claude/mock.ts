import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The claude runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const CLAUDE_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_CLAUDE_BIN',
  script: 'mock-claude.mjs',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...STDIO_ASK_MOCK_SCENARIOS,
    // `mock:auth-error` is a gated failure-control prompt; the control's provider failure is a 400.
    'provider-error': 'mock:request-error',
    'provider-error-controlled': 'mock:auth-error',
    'provider-unavailable': 'mock:provider-unavailable',
    'post-success-refusal': 'mock:model-refusal:always',
    subagent: 'mock:subagents',
    'subagent-after-park': 'mock:subagent-after-park',
    'forked-skill': 'mock:forked-skill',
    'hook-after-park': 'mock:hook-after-park',
    // A line written after the last model call runs as the CLI's next queued turn.
    'steer-late': 'mock:hold',
  },
} as const satisfies RunnerMock;
