import type { RunnerFacts } from '../../core/runner-facts.ts';

/** What the Claude runner's wire can do (`RunnerFacts`). Data only: the adapter class and the
 *  definition read this value, so importing it loads no adapter. */
export const CLAUDE_FACTS = {
  skillTriggerMidTurn: false, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
  // childWork: a subagent's stream-json messages carry parent_tool_use_id (claude-ui-mapper.ts).
  // hookEvents: --include-hook-events streams each hook run (claude-cli-runner.ts).
  // nativePermission: print mode settles every permission inside Claude under its headless
  // --permission-mode (dontAsk denies an unapproved tool without a request); Squawk's own tools are
  // pre-authorized through --allowedTools.
  // transport: claude -p --input-format stream-json --output-format stream-json over stdio.
  // humanPromptHold: sendAgentMessage refuses only for closed stdin, a refusal retry or a pending
  // agent write; a human prompt is a stdin line, and the pipe keeps the order (claude-cli-runner.ts).
  childWork: 'nested', hookEvents: 'reported', nativePermission: 'none', transport: 'stdio', humanPromptHold: 'none',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'write', humanInputAtTurnEnd: 'held-when-late',
    via: 'stream-json stdin line with uuid; --replay-user-messages echo at consumption',
  },
  systemPromptOnResume: 'resent',
  nativeAsk: 'none', nativeSubagents: 'reported', nativeTimerTool: 'ScheduleWakeup', costReport: 'cumulative', sessionIdSource: 'launch',
  claudeModelAliases: true,
  // A stdin user line to an idle session emits claudeTurnStarted in the same write.
  turnStart: 'on-write',
} as const satisfies RunnerFacts;
