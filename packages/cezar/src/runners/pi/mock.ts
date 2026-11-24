import {
  COMMON_MOCK_SCENARIOS,
  PROVIDER_ERROR_MOCK_SCENARIOS,
  STDIO_ASK_MOCK_SCENARIOS,
  type RunnerMock,
} from '@hearsay-tools/squawk/plugin';

/** The pi runner's native mock and its scenario adapter (the `mock` part). Data only. */
export const PI_MOCK = {
  askResumeCases: [{ kind: 'cezar_ask', scenario: 'ask-resume', answer: 'Library: Vitest' }],
  binEnv: 'CEZ_PI_BIN',
  script: 'mock-pi-rpc.mjs',
  // scripts/mock-pi-rpc.mjs: an empty session file holds no session, so the resume opens a fresh one.
  missingSession: { session: 'empty-file' },
  scenarios: {
    ...COMMON_MOCK_SCENARIOS,
    ...STDIO_ASK_MOCK_SCENARIOS,
    ...PROVIDER_ERROR_MOCK_SCENARIOS,
    'provider-unavailable': 'mock:provider-unavailable',
    // No `subagent`: see the S9 and R12 entries in PARITY_EXEMPTIONS.
  },
  // The parity cells this wire cannot carry (`PARITY_EXEMPTIONS`).
  parityExemptions: {
    P9: {
      kind: 'scenario-unconstructible',
      reason: 'Pi\'s RPC wire carries no tool approval request for Squawk to answer; Squawk\'s tools reach Pi as an --extension admitted through --tools (R35), not as an MCP server.',
    },
    // A9: a native mid-turn ask.requested exists only where the declared native ask is answerable;
    // the parity kit checks this reason against the facts.
    A9: {
      kind: 'capability-absent',
      reason: 'Pi RPC asks through cezar_ask; its wire emits no native mid-turn ask.requested (A3/A4 cover the cezar_ask policy).',
    },
    I2: {
      kind: 'capability-absent',
      reason: 'pi 0.87.0 delivers an acknowledged steer in the running turn or runs it as the next prompt (rpc.md steer; #505 repro), so accepted input is never left unread.',
    },
    // D1 (hearsay-tools/cezarion#2279), checked against the installed CLI on 2026-10-30.
    D1: {
      kind: 'capability-absent',
      reason: 'pi 1.4.0 has no built-in cross-session tool; an extension may add one, and its name cannot be discovered as messaging.',
    },
    // D3 (hearsay-tools/cezarion#1994), checked against the installed CLI on 2026-10-27.
    D3: {
      kind: 'capability-absent',
      reason: 'pi 1.4.0 has no built-in messaging tool; an extension may add one, and its name cannot be discovered as messaging.',
    },
    // R77 & UI2 (hearsay-tools/cezarion#961), wire survey 2026-10-15.
    R77: {
      kind: 'scenario-unconstructible',
      reason: 'Pi 1.0.4 runs extensions in-process; its RPC wire reports only extension_error and carries no hook lifecycle frame, so no hook item can arrive after a park (wire survey 2026-10-15).',
    },
    UI2: {
      kind: 'capability-absent',
      reason: 'Pi 1.0.4 runs extensions in-process; its RPC wire reports only extension_error and carries no hook event (wire survey 2026-10-15).',
    },
  },
} as const satisfies RunnerMock;
