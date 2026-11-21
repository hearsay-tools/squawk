import type { RunnerFacts } from '../../core/runner-facts.ts';

/** What the Pi runner's wire can do (`RunnerFacts`). Data only: the adapter class and the
 *  definition read this value, so importing it loads no adapter. */
export const PI_FACTS = {
  shutdownDescendants: 'process-group',
  skillTriggerMidTurn: true, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
  // childWork: Pi RPC has no child session; a task tool is a plain tool call on the parent
  // session (__fixtures__/rpc-lifecycle.expected.json).
  // hookEvents: Pi 1.0.4 runs extensions in-process; its RPC wire reports only extension_error.
  // nativePermission: Pi RPC carries no tool approval request; tool admission is --tools.
  // transport: pi --mode rpc over stdio.
  // humanPromptHold: a human prompt carries no id; sendAgentMessage refuses while
  // humanPromptAcks > 0, and only its prompt response, in write order, settles it (pi-runner.ts).
  childWork: 'none', hookEvents: 'none', nativePermission: 'none', transport: 'stdio', humanPromptHold: 'acknowledgement',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late',
    via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
  },
  systemPromptOnResume: 'resent',
  nativeAsk: 'none', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'launch',
  claudeModelAliases: false,
  // A prompt to an idle session emits piTurnStarted in the same write.
  turnStart: 'on-write',
} as const satisfies RunnerFacts;
