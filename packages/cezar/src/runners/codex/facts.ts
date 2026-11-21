import type { RunnerFacts } from '../../core/runner-facts.ts';

/** What the Codex runner's wire can do (`RunnerFacts`). Data only: the adapter class and the
 *  definition read this value, so importing it loads no adapter. */
export const CODEX_FACTS = {
  shutdownDescendants: 'process-group',
  skillTriggerMidTurn: false, skillUnknownName: 'silent', skillsSeenBySession: 'live',
  // childWork: a child thread's items nest under its spawnAgent item through collabParentItemId
  // (codex-hook-mapper.ts).
  // hookEvents: app-server sends hook/started and hook/completed (codex-hook-mapper.ts).
  // nativePermission: app-server sends an approval request only inside the turn its turnId names;
  // noteTurnEnded expires every pending approval (codex-app-server-runner.ts), so a done closes at once.
  // transport: codex app-server JSON-RPC lines over stdio.
  // humanPromptHold: sendAgentMessage refuses while humanPromptsPending > 0; the userMessage
  // item of the prompt (noteHumanEcho) releases it before the turn/start or turn/steer response
  // (codex-app-server-runner.ts).
  childWork: 'nested', hookEvents: 'reported', nativePermission: 'in-turn', transport: 'stdio', humanPromptHold: 'consumption',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late',
    // The userMessage item marks the input entering the thread's history (probe 2026-09-24:
    // 0.8 s and 26.7 s after the steer, both before the tool ended); the next model call reads it.
    via: 'turn/steer with clientUserMessageId; item/started userMessage clientId once in the thread history',
  },
  systemPromptOnResume: 'in-thread',
  nativeAsk: 'answerable', nativeSubagents: 'reported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  claudeModelAliases: false,
  // The turn/started notification after the turn/start or turn/steer response.
  turnStart: 'on-wire',
} as const satisfies RunnerFacts;
