import type { RunnerFacts } from '../../core/runner-facts.ts';
// Live Google antigravity-acp 1.5.0 probes: hearsay-tools/squawk#4000.
export const ANTIGRAVITY_FACTS = {
  shutdownDescendants: 'observed-tree',
  skillTriggerMidTurn: true, skillUnknownName: 'silent', skillsSeenBySession: 'live',
  transport: 'stdio', sessionIdSource: 'native', systemPromptOnResume: 'resent',
  inputDelivery: { mode: 'steer', consumption: 'unobservable', acknowledgement: 'response',
    humanInputAtTurnEnd: 'held-when-late', via: 'second session/prompt while busy' },
  nativePermission: 'in-turn', nativeAsk: 'answerable', nativeSubagents: 'turn-held',
  childWork: 'none', hookEvents: 'none', humanPromptHold: 'acknowledgement',
  nativeTimerTool: null, costReport: 'per-turn', claudeModelAliases: false, turnStart: 'on-write',
} as const satisfies RunnerFacts;
