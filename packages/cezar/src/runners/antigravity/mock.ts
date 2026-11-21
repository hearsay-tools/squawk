import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS, NATIVE_APPROVAL_MOCK_SCENARIOS } from '../mock-prompts.ts';
export const ANTIGRAVITY_MOCK = {
  script: 'mock-acp.mjs', toolGrantObservation: 'permission-policy', promptResponseEndsTurn: true, defaultApprovalEcho: 'Approval response: allow', malformedApprovalEcho: 'Malformed permission refused', binEnv: 'HSQ_ANTIGRAVITY_BIN',
  scenarios: { ...COMMON_MOCK_SCENARIOS, ...STDIO_ASK_MOCK_SCENARIOS, ...PROVIDER_ERROR_MOCK_SCENARIOS,
    ...NATIVE_APPROVAL_MOCK_SCENARIOS, ask: 'mock:ask-native', 'ask-resume': 'mock:ask-native mock:resume-cezar-done', 'permission-default': 'mock:permission-default', 'approval-malformed': 'mock:approval-malformed', 'provider-unavailable': 'mock:provider-unavailable' },
  askResumeCases: [{ kind: 'interaction', scenario: 'ask-resume', answer: 'Question: Vitest', header: 'Question' }],
  scenarioEnv: { approval: { HSQ_APPROVAL_GATE: '1' }, 'approval-turn-end': { HSQ_APPROVAL_GATE: '1' } },
  approvalDecisions: [{ pick: 'Allow once', echo: 'Approval response: allow' }, { pick: 'Deny', echo: 'Approval response: deny' }],
  parityExemptions: {
    D1: { kind: 'capability-absent', reason: 'Antigravity ACP 1.5.0 has no native cross-session messaging tool to disable.' },
    D3: { kind: 'capability-absent', reason: 'Antigravity ACP 1.5.0 has no native cross-session messaging tool.' },
    P3: { kind: 'scenario-unconstructible', reason: 'ACP has no provider notification that resolves its own pending permission.' },
    P5: { kind: 'scenario-unconstructible', reason: 'ACP JSON-RPC has no response to a permission response that can reject the reply.' },
    P7: { kind: 'scenario-unconstructible', reason: 'ACP default mode permission policy has no asynchronous configuration classification window.' },
    P9: { kind: 'scenario-unconstructible', reason: 'ACP MCP calls use the ordinary session/request_permission wire rather than a distinct MCP approval request.' },
  },
} as const satisfies RunnerMock;
