import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS, NATIVE_APPROVAL_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The codex runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const CODEX_MOCK = {
  askResumeCases: [{ kind: 'item/tool/requestUserInput', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_CODEX_BIN',
  script: 'mock-codex-app-server.mjs',
  approvalDecisions: [
    { pick: 'decline', echo: 'Approval response: {"decision":"decline"}' },
    { pick: 'cancel', echo: 'Approval response: {"decision":"cancel"}' },
  ],
  malformedApprovalEcho: 'Approval error: -32602',
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...PROVIDER_ERROR_MOCK_SCENARIOS,
    ...NATIVE_APPROVAL_MOCK_SCENARIOS,
    'approval-malformed': 'mock:approval-malformed',
    'mcp-approval': 'mock:mcp-approval',
    'silent-tail-late-turn-start': 'mock:silent-tail-late-turn-start',
    'provider-unavailable': 'mock:stream-retry',
    ask: 'mock:native-codex-ask',
    'ask-resume': 'mock:native-codex-ask mock:resume-cezar-done',
    'ask-reply-late': 'mock:native-codex-ask',
    // #600's repro: a child thread's own turn/completed must not end the parent.
    subagent: 'mock:child-turn',
    'subagent-after-park': 'mock:subagent-after-park',
    'hook-after-park': 'mock:hook-after-park',
  },
} as const satisfies RunnerMock;
