import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS } from '../mock-prompts.ts';
const { 'no-progress-ack-only': _ackWithoutTurn, 'silent-tail-no-reply': _noReply, 'silent-tail-late-reply': _lateReply, ...commonScenarios } = COMMON_MOCK_SCENARIOS;
export const ANTIGRAVITY_MOCK = {
  nativeAskScenario: 'ask-resume',
  script: 'mock-acp.mjs', toolGrantObservation: 'permission-policy', promptResponseEndsTurn: true, defaultApprovalEcho: 'Approval response: allow', malformedApprovalEcho: 'Malformed permission refused', binEnv: 'HSQ_ANTIGRAVITY_BIN',
  scenarios: { ...commonScenarios, ...STDIO_ASK_MOCK_SCENARIOS, ...PROVIDER_ERROR_MOCK_SCENARIOS,
    approval: 'mock:approval', 'approval-turn-end': 'mock:approval-turn-end', 'ask-bad': 'mock:ask-bad', 'ask-resume': 'mock:ask-native mock:resume-cezar-done', 'permission-default': 'mock:permission-default', 'approval-malformed': 'mock:approval-malformed', 'provider-unavailable': 'mock:provider-unavailable' },
  askResumeCases: [{ kind: 'interaction', scenario: 'ask-resume', answer: 'Question: Vitest', header: 'Question' }],
  scenarioEnv: { approval: { HSQ_APPROVAL_GATE: '1' }, 'approval-turn-end': { HSQ_APPROVAL_GATE: '1' } },
  approvalDecisions: [{ pick: 'allow', echo: 'Approval response: allow' }, { pick: 'deny', echo: 'Approval response: deny' }],
  parityExemptions: {
    N8: { kind: 'scenario-unconstructible', reason: 'An idle ACP session/prompt starts a normalized turn on write and acknowledges only at completion; no idle ACK without turn-start exists (recording prompt-text-usage, docs/runners/antigravity-wire.md).' },
    F9: { kind: 'scenario-unconstructible', reason: 'ACP idle session/prompt response completes the turn; acknowledgement and turn completion cannot be separated (recording prompt-text-usage, docs/runners/antigravity-wire.md).' },
    F8: { kind: 'scenario-unconstructible', reason: 'ACP idle session/prompt response completes its turn; it cannot acknowledge a nudge without completing a turn (recording prompt-text-usage, docs/runners/antigravity-wire.md).' },
    UI1: { kind: 'capability-absent', reason: 'Antigravity ACP 1.5.0 sends no plan update; /plan writes an artifact instead (docs/runners/antigravity-wire.md, Gaps that need a parity exemption).' },
    D1: { kind: 'capability-absent', reason: 'Antigravity ACP 1.5.0 has no native cross-session messaging tool to disable.' },
    D3: { kind: 'capability-absent', reason: 'Antigravity ACP 1.5.0 has no native cross-session messaging tool.' },
    P3: { kind: 'scenario-unconstructible', reason: 'ACP has no provider notification that resolves its own pending permission.' },
    P5: { kind: 'scenario-unconstructible', reason: 'ACP JSON-RPC has no response to a permission response that can reject the reply.' },
    P7: { kind: 'scenario-unconstructible', reason: 'ACP default mode permission policy has no asynchronous configuration classification window.' },
    P9: { kind: 'scenario-unconstructible', reason: 'ACP MCP calls use the ordinary session/request_permission wire rather than a distinct MCP approval request.' },
  },
} as const satisfies RunnerMock;
