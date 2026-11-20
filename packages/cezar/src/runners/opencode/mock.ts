import type { RunnerMock } from '../../core/runner-definition.ts';
import { MOCK_BASELINE_PROMPT, COMMON_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS, NATIVE_APPROVAL_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The opencode runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const OPENCODE_MOCK = {
  askResumeCases: [{ kind: 'question.asked', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_OPENCODE_BIN',
  script: 'mock-opencode-serve.mjs',
  approvalDecisions: [
    { pick: 'reject', echo: 'Approval response: {"reply":"reject"}' },
    { pick: 'allow once', echo: 'Approval response: {"reply":"once"}' },
  ],
  malformedApprovalEcho: 'Approval response: {"reply":"reject"}',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...PROVIDER_ERROR_MOCK_SCENARIOS,
    ...NATIVE_APPROVAL_MOCK_SCENARIOS,
    'permission-default': 'mock:permission-default',
    'approval-reply-fails': 'mock:approval-reply-fails',
    'approval-malformed': 'mock:permission-malformed',
    'permission-classify': 'mock:permission-classify',
    'permission-late': 'mock:permission-late',
    'skill-warning': 'mock:skill-warning mock:cezar-done',
    // The failing start is set by driveSeam's env (no prompt exists before listening).
    'serve-start-exit': MOCK_BASELINE_PROMPT,
    'silent-tail-ack-delay': 'mock:silent-tail f7-delay-ack',
    'provider-unavailable': 'mock:provider-unavailable',
    ask: 'mock:ask',
    'ask-resume': 'mock:ask mock:resume-cezar-done',
    'ask-reply-late': 'mock:ask-reply-late',
    subagent: 'mock:subagent',
    'subagent-after-park': 'mock:subagent-after-park',
  },
} as const satisfies RunnerMock;
