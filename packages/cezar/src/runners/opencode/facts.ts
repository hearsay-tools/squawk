import type { RunnerFacts } from '../../core/runner-facts.ts';

/** What the OpenCode runner's wire can do (`RunnerFacts`). Data only: the adapter class and the
 *  definition read this value, so importing it loads no adapter. */
export const OPENCODE_FACTS = {
  skillTriggerMidTurn: false, skillUnknownName: 'error', skillsSeenBySession: 'at-start',
  // childWork: a subtask's child-session parts nest under the subtask part (opencode-ui-mapper.ts).
  // hookEvents: OpenCode 1.18.35 runs plugin hooks in-process; its SSE wire carries no hook event.
  // nativePermission: a main-session permission.asked after session.idle means the server started
  // a run, and the runner reopens the turn for it; endWhenQuiet keeps a done session up for it
  // (opencode-server-runner.ts).
  // transport: opencode serve --hostname 127.0.0.1 --port N; HTTP requests and an SSE event stream.
  // humanPromptHold: sendAgentMessage refuses while pendingPromptRequests > 0, which drops only
  // when the prompt's HTTP request resolves (deliverPrompt, opencode-server-runner.ts).
  childWork: 'nested', hookEvents: 'none', nativePermission: 'after-turn', transport: 'http', humanPromptHold: 'acknowledgement',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'always-held',
    via: 'prompt_async while busy; assistant message.updated parentID at consumption',
  },
  systemPromptOnResume: 'in-thread',
  nativeAsk: 'answerable', nativeSubagents: 'turn-held', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'native',
  claudeModelAliases: false,
  // A human prompt_async POST goes out after the ready promise, so after sendMessage returns.
  turnStart: 'on-wire',
} as const satisfies RunnerFacts;
