import type { RunnerFacts } from '../../core/runner-facts.ts';
// Live Google Antigravity CLI 1.5.14 probes (hearsay-tools/squawk#4058, hearsay-tools/squawk#4060);
// docs/runners/antigravity-wire.md names the fixture behind each value.
// systemPromptOnResume: the CLI saves the session/new system prompt with the session and appends
// a resent one, so a resume never resends it; it prepends it to the opening turn, as Codex does.
// humanInputAtTurnEnd: a steer sent while the final text streamed was read in the same turn.
// nativePermission: a background command or timer wakes the idle session, which then asks.
// nativeSubagents: a subagent's permission requests never reach the ACP client, so a PreToolUse hook
// denies the subagent tools (subagent-guard.ts, hearsay-tools/squawk#4098).
export const ANTIGRAVITY_FACTS = {
  shutdownDescendants: 'observed-tree',
  skillTriggerMidTurn: true, skillUnknownName: 'silent', skillsSeenBySession: 'live',
  transport: 'stdio', sessionIdSource: 'native', systemPromptOnResume: 'in-thread',
  inputDelivery: { mode: 'steer', consumption: 'unobservable', acknowledgement: 'response',
    humanInputAtTurnEnd: 'never-held', via: 'second session/prompt while busy' },
  nativePermission: 'after-turn', nativeAsk: 'answerable', nativeSubagents: 'none',
  childWork: 'none', hookEvents: 'none', humanPromptHold: 'acknowledgement',
  nativeTimerTool: 'schedule', costReport: 'per-turn', claudeModelAliases: false, turnStart: 'on-write',
} as const satisfies RunnerFacts;
