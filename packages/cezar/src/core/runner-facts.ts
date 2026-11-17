import { RUNNER_IDS, type InputDelivery, type RunnerId, type SystemPromptOnResume } from './agent-runner.ts';

/**
 * What one runner's wire can do, declared once per runner id (hearsay-tools/cezarion#2991).
 * Shared code often holds only a `RunnerId`, because it builds the runner later, so it reads
 * this table instead of comparing runner ids. Each runner class exposes its own row as
 * `facts`, and reads its `inputDelivery` and `systemPromptOnResume` from it.
 * `runner-facts.test.ts` checks that every runner `createRunner` builds carries the row for its
 * id. A test that must not load the runner classes reads the same row here.
 */
export interface RunnerFacts {
  /** A native skill can be triggered while a turn is running. */
  readonly skillTriggerMidTurn: boolean;
  /** What the native trigger does with an unknown id. */
  readonly skillUnknownName: 'error' | 'silent';
  /** Whether an existing session sees later skill additions. */
  readonly skillsSeenBySession: 'live' | 'at-start';
  /** How the runner admits input while a turn runs (`InputDelivery`, hearsay-tools/cezarion#505). */
  readonly inputDelivery: InputDelivery;
  /** How the runner carries `spec.systemPrompt` onto a resumed session (hearsay-tools/cezarion#790). */
  readonly systemPromptOnResume: SystemPromptOnResume;
  /**
   * The harness's own question tool. `answerable`: the wire reports the question and Squawk routes
   * the human answer back to it. `none`: the wire has no native question; the agent asks through
   * `cezar_ask`.
   */
  readonly nativeAsk: 'answerable' | 'none';
  /**
   * Backgrounded native subagents. `reported`: the wire reports a child's start and end, so Squawk
   * waits on the child. `unreported`: the wire sends no child signal. `turn-held`: the parent turn
   * stays open until every child returns, so no turn end parks on running children.
   */
  readonly nativeSubagents: 'reported' | 'unreported' | 'turn-held';
  /**
   * A native subagent's own work. `nested`: the wire reports a child's items together with the
   * parent tool call that started the child, so the child's work nests under that call. `none`:
   * the wire carries no child session and no child transcript.
   */
  readonly childWork: 'nested' | 'none';
  /** Hook runs. `reported`: the wire streams each hook run, which Squawk maps to a hook item.
   *  `none`: hooks run inside the harness and the wire carries no hook frame. */
  readonly hookEvents: 'reported' | 'none';
  /**
   * How long a human prompt on its way to the wire holds agent input back. `none`: agent input is
   * never refused for a human prompt. `consumption`: the hold ends when the wire reports the prompt
   * read; a prompt that starts a turn is also released by that start's acknowledgement, and a prompt
   * steered into a running turn by the turn's end. `acknowledgement`: the hold ends only at the
   * prompt's acknowledgement.
   */
  readonly humanPromptHold: 'none' | 'consumption' | 'acknowledgement';
  /**
   * The harness's native permission request, which Squawk answers through the cockpit permission
   * card. `none`: the wire carries no permission request. `in-turn`: a request arrives only inside
   * the running turn, so none arrives after the turn ends. `after-turn`: a request can also arrive
   * after the turn ended, and it reopens the turn. An accepted done closes an `after-turn` session
   * through `AgentSession.endWhenQuiet`, which waits `AUTO_END_DELAY_MS` for such a request; every
   * other session closes at once, and a request its wire raises after that close is never shown
   * (hearsay-tools/squawk#1680).
   */
  readonly nativePermission: 'none' | 'in-turn' | 'after-turn';
  /** How Squawk reaches the native wire. `stdio`: the stdin and stdout of the spawned process
   *  carry it. `http`: Squawk spawns a server, waits for it to listen, and talks to it over HTTP. */
  readonly transport: 'stdio' | 'http';
  /** The native tool that schedules the session's own wake-up, the equivalent of a `cezar_wait`
   *  timer; null when the wire has none. A tool of the same name on another wire means nothing. */
  readonly nativeTimerTool: string | null;
  /** `cumulative`: each cost report is the session total so far, Continue steps included.
   *  `per-turn`: each report is new cost since the previous report. */
  readonly costReport: 'cumulative' | 'per-turn';
  /**
   * Who names the session. `launch`: the runner opens its session under the id Squawk saves on the
   * step before launch, so that id resumes at once. `native`: the runner mints its own id and
   * reports it in a `session` event; until then the step holds only Squawk's launch id, which the
   * runner never knew. The `sessionId` row of each runner's `specSupport` names the wire.
   */
  readonly sessionIdSource: 'launch' | 'native';
  /** The CLI takes Claude's model aliases (`sonnet`, `haiku`). The `plannerModel` and `namerModel`
   *  presets are such aliases, so only such a runner gets them; another runs on its own default. */
  readonly claudeModelAliases: boolean;
  /**
   * When the runner reports the turn that a human `sendMessage` to an idle session opens.
   * `on-write`: `turn.started` is emitted inside `sendMessage`, before the call returns.
   * `on-wire`: it comes later, from a wire frame or a later process. Seam row S37 checks it. Shared
   * code must not read it; tests use it to pick runners.
   */
  readonly turnStart: 'on-write' | 'on-wire';
}

export const RUNNER_FACTS = {
  claude: {
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
  },
  codex: {
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
  },
  opencode: {
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
  },
  pi: {
    skillTriggerMidTurn: true, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
    // childWork: Pi RPC has no child session; a task tool is a plain tool call on the parent
    // session (__fixtures__/pi/rpc-lifecycle.expected.json).
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
  },
  omp: {
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
  },
} as const satisfies Readonly<Record<RunnerId, RunnerFacts>>;

/** The runners whose declared facts match, in `RUNNER_IDS` order. */
export function runnersWhere(matches: (facts: RunnerFacts) => boolean): RunnerId[] {
  return RUNNER_IDS.filter(id => matches(RUNNER_FACTS[id]));
}
