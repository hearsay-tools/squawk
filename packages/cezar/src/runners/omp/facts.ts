import type { RunnerFacts } from '../../core/runner-facts.ts';

/** What the OMP runner's wire can do (`RunnerFacts`). Data only: the adapter class and the
 *  definition read this value, so importing it loads no adapter. */
export const OMP_FACTS = {
  shutdownDescendants: 'process-group',
  skillTriggerMidTurn: true, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
  // childWork: subagent_event frames carry subagent_lifecycle.parentToolCallId of their task call
  // (omp-subagent-rows.ts).
  // hookEvents: OMP 18.8.0 shares Pi's RPC wire: extensions run in-process and report only
  // extension_error.
  // nativePermission: OMP RPC carries no tool approval request; tool admission is its --tools list
  // and --config overlay.
  // transport: omp --mode rpc over stdio.
  // humanPromptHold: sendAgentMessage refuses while humanAcks holds the prompt's id; only its
  // prompt response deletes it (omp-runner.ts).
  childWork: 'nested', hookEvents: 'none', nativePermission: 'none', transport: 'stdio', humanPromptHold: 'acknowledgement',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'never-held',
    via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
  },
  systemPromptOnResume: 'resent',
  nativeAsk: 'none', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  claudeModelAliases: false,
  // A prompt to an idle session emits ompTurnStarted in the same write.
  turnStart: 'on-write',
} as const satisfies RunnerFacts;
