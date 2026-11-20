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
  // The parity cells this wire cannot carry (`PARITY_EXEMPTIONS`).
  parityExemptions: {
    P9: {
      kind: 'scenario-unconstructible',
      reason: 'OpenCode sends no MCP-specific approval request: an ask before any tool call arrives as an ordinary permission.asked from a rule the user wrote, which P1 routes to the cockpit card (hearsay-tools/cezarion#1266).',
    },
    // U20h (hearsay-tools/cezarion#1301): a refusal the harness acknowledges and never answers.
    U20h: {
      kind: 'capability-absent',
      reason: 'OpenCode runs one prompt per turn: a human prompt waits for the busy turn to go idle, and a refusal acknowledged without a turn never goes idle, so the human message the cell sends after the bound is never posted.',
    },
    // D3 (hearsay-tools/cezarion#1994), checked against the installed CLI on 2026-10-27.
    D3: {
      kind: 'capability-absent',
      reason: 'OpenCode 1.19.4 has no messaging tool and no inbound channel. Its task tool resumes any session by task_id with no parent check, and the task permission pattern matches only subagent_type, so no session rule blocks a foreign task_id while subagents keep working. Only the shell finds another session\'s ID, and the shell reaches that session directly (opencode run --session); the same-user shell is outside hard isolation.',
    },
  },
} as const satisfies RunnerMock;
