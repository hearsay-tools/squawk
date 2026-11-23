import type { RunnerMock } from '../../core/runner-definition.ts';
import { MOCK_BASELINE_PROMPT, COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** The omp runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const OMP_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_OMP_BIN',
  script: 'mock-omp-rpc.mjs',
  // scripts/mock-omp-rpc.mjs: CEZ_MOCK_OMP_RESUME_MOVED reports the session moved to a new id.
  missingSession: { session: 'empty-file', env: { CEZ_MOCK_OMP_RESUME_MOVED: '1' } },
  // scripts/mock-omp-rpc.mjs reads these at start: a closed input pipe, and an implicit autoResume.
  scenarioEnv: { 'closed-input': { CEZ_MOCK_OMP_CLOSED_INPUT: '1' }, 'auto-resumed': { CEZ_MOCK_OMP_AUTO_RESUME: '1' } },
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
  // The parity cells this wire cannot carry (`PARITY_EXEMPTIONS`).
  parityExemptions: {
    P9: {
      kind: 'scenario-unconstructible',
      reason: 'OMP\'s RPC wire carries no tool approval request for Squawk to answer: tool admission is its --tools list and --config overlay; Squawk\'s tools reach OMP as an --extension admitted through --tools (R35), not as an MCP server.',
    },
    // A9: a native mid-turn ask.requested exists only where the declared native ask is answerable;
    // the parity kit checks this reason against the facts.
    A9: {
      kind: 'capability-absent',
      reason: 'OMP v18.4.11 plain `--mode rpc` never constructs the ask tool: sessionOptions.hasUI is true only for interactive or rpc-ui (src/main.ts) and AskTool.createIf returns null without it, so the native ask path cannot exist on the wire Squawk uses. Asks go through cezar_ask (A3/A4 cover the cezar_ask policy).',
    },
    I2: {
      kind: 'capability-absent',
      reason: 'OMP v18.4.11 session_settled requires queuedMessageCount === 0 (isRpcSessionSettled, modes/rpc/rpc-session-settle.ts), and agent_end is rewritten to isTerminal:false while agent.hasQueuedMessages() (session/agent-session.ts), so a steer accepted before settle is read in the same turn and accepted input is never left unread.',
    },
    // D1 (hearsay-tools/cezarion#2279), checked against the installed CLI on 2026-10-30.
    D1: {
      kind: 'capability-absent',
      reason: 'OMP 18.13.1 has no cross-session tool in its default set; its irc tool is an in-process bus that reaches only agents inside the same OMP process.',
    },
    // D3 (hearsay-tools/cezarion#1994), checked against the installed CLI on 2026-10-27.
    D3: {
      kind: 'capability-absent',
      reason: 'OMP 18.13.1 get_state.dumpTools default set holds no messaging tool; vibe_* and irc are opt-in in the user\'s own config.',
    },
    // R77 & UI2 (hearsay-tools/cezarion#961), wire survey 2026-10-15.
    R77: {
      kind: 'scenario-unconstructible',
      reason: 'OMP 18.8.0 shares Pi\'s RPC wire: extensions run in-process and report only extension_error, so no hook item can arrive after a park (wire survey 2026-10-15).',
    },
    UI2: {
      kind: 'capability-absent',
      reason: 'OMP 18.8.0 shares Pi\'s RPC wire: extensions run in-process and report only extension_error, with no hook event (wire survey 2026-10-15).',
    },
  },
} as const satisfies RunnerMock;
