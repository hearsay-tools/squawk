import { type RunnerMock, COMMON_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS, NATIVE_APPROVAL_MOCK_SCENARIOS } from '@hearsay-tools/squawk/plugin';

/** Why the A13 and A14 cells cannot run on this wire. */
const PROMPT_ACK_REASON = 'Codex refuses agent input only while a human prompt is still on its way to the wire, and that prompt is held human input: the turn end takes it before any nudge.';

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
  // The parity cells this wire cannot carry (`PARITY_EXEMPTIONS`).
  parityExemptions: {
    P2: {
      kind: 'scenario-unconstructible',
      reason: 'every app-server approval request comes from Codex\'s own approval policy or MCP tool approval mode, which Squawk leaves to Codex and P1 and P9 route to the human; the wire has no built-in ask that Squawk answers.',
    },
    P5: {
      kind: 'scenario-unconstructible',
      reason: 'Codex answers an approval with a JSON-RPC response written to app-server stdin. JSON-RPC sends no reply to a response, so the wire has no per-answer refusal: the write reaches the server, or the transport fails and the session ends.',
    },
    P7: {
      kind: 'scenario-unconstructible',
      reason: 'A Codex approval request is already Codex\'s own decision to ask (its approval policy runs server-side), so Squawk shows the card on receipt with nothing to read first; there is no window between receipt and the card.',
    },
    // hearsay-tools/squawk#2452: the live A13/A14 rows run where a prompt acknowledgement can be
    // outstanding at a turn end with no human input held.
    A13: {
      kind: 'capability-absent',
      reason: PROMPT_ACK_REASON,
    },
    A14: {
      kind: 'capability-absent',
      reason: PROMPT_ACK_REASON,
    },
    // D3 (hearsay-tools/cezarion#1994), checked against the installed CLI on 2026-10-27.
    D3: {
      kind: 'capability-absent',
      reason: 'Codex 0.164.0 multi-agent tools reach only agents of the same session; the cross-thread agent_message_board feature is under development and off by default, so Squawk sends no flag for an unstable key.',
    },
  },
} as const satisfies RunnerMock;
