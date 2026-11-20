import type { RunnerMock } from '../../core/runner-definition.ts';
import { COMMON_MOCK_SCENARIOS, STDIO_ASK_MOCK_SCENARIOS } from '../mock-prompts.ts';

/** Why the A13 and A14 cells cannot run on this wire. */
const PROMPT_ACK_REASON = 'Claude acknowledges input with its own stdin write, so no prompt acknowledgement is outstanding at a turn end, and it refuses agent input only while its own agent write is pending.';

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
  // The parity cells this wire cannot carry (`PARITY_EXEMPTIONS`).
  parityExemptions: {
    P9: {
      kind: 'scenario-unconstructible',
      reason: 'Claude print mode settles every tool permission inside Claude under its headless --permission-mode and sends Squawk no MCP tool approval request; Squawk\'s own tools are pre-authorized through generated --allowedTools entries (R35).',
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
    // hearsay-tools/squawk#2443: the live row holds the nudge's acknowledgement on every wire that
    // acknowledges apart from its own write.
    A15: {
      kind: 'capability-absent',
      reason: 'Claude acknowledges input with its own stdin write, so a submitted nudge cannot wait for its acknowledgement. The cell pins the inverted assertion: every acknowledgement cancels its bound and the run continues to the cap.',
    },
    // A9: a native mid-turn ask.requested exists only where the declared native ask is answerable;
    // the parity kit checks this reason against the facts.
    A9: {
      kind: 'capability-absent',
      reason: 'Claude stream-json asks through cezar_ask; its wire emits no native mid-turn ask.requested (A3/A4 cover the cezar_ask policy).',
    },
    I2: {
      kind: 'capability-absent',
      reason: 'Claude 2.1.280 runs a stdin line written after the last model call as its own following result (queued_turn_count), so accepted input is never left unread (#505).',
    },
    // U12/U13: an agent-input acknowledgement the provider can delay or reject.
    U12: {
      kind: 'capability-absent',
      reason: 'Claude acknowledges agent input with the local stdin pipe write, so the provider cannot delay the acknowledgement. U3b covers its delivery beside a pending question.',
    },
    U13: {
      kind: 'capability-absent',
      reason: 'Claude acknowledges agent input with the local stdin pipe write; a written line has no provider rejection.',
    },
    // U27 (hearsay-tools/cezarion#1525): the late-acknowledgement entry needs a turn that ends
    // before its input is acknowledged.
    U27: {
      kind: 'capability-absent',
      reason: 'Claude acknowledges agent input with the local stdin pipe write, so no turn can end before its input is acknowledged; its fresh-step and Continue cells still run.',
    },
    // D1 (hearsay-tools/cezarion#2279), checked against the installed CLI on 2026-10-30.
    D1: {
      kind: 'capability-absent',
      reason: 'Claude Code 2.1.312 SendMessage and ListAgents also reach the session\'s own subagents, so no outbound tool is separate from subagent messaging; inbound messages from other sessions are refused on every launch (D3).',
    },
  },
} as const satisfies RunnerMock;
