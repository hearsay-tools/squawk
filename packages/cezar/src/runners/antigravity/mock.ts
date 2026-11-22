import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS } from '../mock-prompts.ts';
const { 'no-progress-ack-only': _ackWithoutTurn, 'silent-tail-no-reply': _noReply, 'silent-tail-late-reply': _lateReply, ...commonScenarios } = COMMON_MOCK_SCENARIOS;
export const ANTIGRAVITY_MOCK = {
  nativeAskScenario: 'ask-resume',
  script: 'mock-acp.mjs', toolGrantObservation: 'permission-policy', promptResponseEndsTurn: true, defaultApprovalEcho: 'Approval response: allow', malformedApprovalEcho: 'Malformed permission refused', binEnv: 'HSQ_ANTIGRAVITY_BIN',
  scenarios: { ...commonScenarios, ...STDIO_ASK_MOCK_SCENARIOS, ...PROVIDER_ERROR_MOCK_SCENARIOS,
    approval: 'mock:approval', 'approval-turn-end': 'mock:approval-turn-end', 'ask-bad': 'mock:ask-bad', 'ask-resume': 'mock:ask-native mock:resume-cezar-done', 'permission-late': 'mock:permission-late', 'permission-default': 'mock:permission-default', 'approval-malformed': 'mock:approval-malformed', 'provider-unavailable': 'mock:provider-unavailable' },
  askResumeCases: [{ kind: 'ask_question', scenario: 'ask-resume', answer: 'Question: Vitest', header: 'Question' }],
  scenarioEnv: { approval: { HSQ_APPROVAL_GATE: '1' }, 'approval-turn-end': { HSQ_APPROVAL_GATE: '1' }, 'permission-late': { HSQ_APPROVAL_GATE: '1' },
    // P8's Continue variant sends permission-late to a run started as cezar-done: its late request needs the same gate.
    'cezar-done': { HSQ_APPROVAL_GATE: '1' } },
  approvalDecisions: [{ pick: 'allow', echo: 'Approval response: allow' }, { pick: 'deny', echo: 'Approval response: deny' }],
  parityExemptions: {
    A13: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so no independent ACK can remain pending after the carrying turn and cause an idle refusal on a fresh run. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    A14: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so no independent ACK can remain pending after the carrying turn and cause an idle refusal on Continue. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    A15: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so an unanswered independent ACK cannot leave a completed nudge turn behind it to arm the idle reply bound. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    U20h: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so an independently acknowledged but unanswered refusal cannot park before its turn ends and start the next human cycle. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    U22s: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so the silent refusal variant cannot independently acknowledge a nudge without completing its turn. Closing-session delivery and restart variants remain live in U22k/U22r. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    U27: { kind: 'capability-absent', reason: 'The native prompt response is also turn completion, so no independent ACK can arrive after the carrying turn completes. Fresh and Continue entries without this late-ACK ordering remain live. Evidence: __fixtures__/cli-prompt-command.ndjson and docs/runners/antigravity-wire.md.' },
    N8: { kind: 'scenario-unconstructible', reason: 'An idle ACP session/prompt starts a normalized turn on write and acknowledges only at completion; no idle ACK without turn-start exists (recording cli-prompt-command, docs/runners/antigravity-wire.md).' },
    F9: { kind: 'scenario-unconstructible', reason: 'ACP idle session/prompt response completes the turn; acknowledgement and turn completion cannot be separated (recording cli-prompt-command, docs/runners/antigravity-wire.md).' },
    F8: { kind: 'scenario-unconstructible', reason: 'ACP idle session/prompt response completes its turn; it cannot acknowledge a nudge without completing a turn (recording cli-prompt-command, docs/runners/antigravity-wire.md).' },
    UI1: { kind: 'capability-absent', reason: 'The Antigravity CLI sends no ACP plan update; plan is a mode and a command that write an artifact (docs/runners/antigravity-wire.md, Parity exemptions).' },
    D1: { kind: 'capability-absent', reason: 'The Antigravity CLI send_message tool reaches only the session\'s own subagents; there is no tool that messages another session to disable (docs/runners/antigravity-wire.md, Parity exemptions).' },
    D3: { kind: 'capability-absent', reason: 'The Antigravity CLI send_message tool reaches only the session\'s own subagents; it has no tool that messages another session (docs/runners/antigravity-wire.md, Parity exemptions).' },
    P3: { kind: 'scenario-unconstructible', reason: 'ACP has no provider notification that resolves its own pending permission.' },
    P5: { kind: 'scenario-unconstructible', reason: 'ACP JSON-RPC has no response to a permission response that can reject the reply.' },
    P7: { kind: 'scenario-unconstructible', reason: 'ACP default mode permission policy has no asynchronous configuration classification window.' },
    P9: { kind: 'scenario-unconstructible', reason: 'ACP MCP calls use the ordinary session/request_permission wire rather than a distinct MCP approval request.' },
  },
} as const satisfies RunnerMock;
