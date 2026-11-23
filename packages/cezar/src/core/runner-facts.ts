import type { InputDelivery, SystemPromptOnResume } from './agent-runner.ts';
import { knownRunnerIds, registeredRunners, resolveRunnerId, runnerDefinition } from './runner-registry.ts';

/**
 * What one runner's wire can do, declared once per runner id (hearsay-tools/cezarion#2991) in its
 * `runners/<id>/facts.ts`. Shared code often holds only a `string`, because it builds the
 * runner later, so it reads `RUNNER_FACTS` instead of comparing runner ids. Each runner class
 * exposes its own value as `facts`, and reads its `inputDelivery` and `systemPromptOnResume` from
 * it. `runner-facts.test.ts` checks that every runner `createRunner` builds carries the facts of
 * its definition.
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
   * stays open until every child returns, so no turn end parks on running children. `none`: Squawk
   * turns the native subagent tools off, so no child runs.
   */
  readonly nativeSubagents: 'reported' | 'unreported' | 'turn-held' | 'none';
  /**
   * A native subagent's own work. `nested`: the wire reports a child's items together with the
   * parent tool call that started the child, so the child's work nests under that call. `none`:
   * the wire carries no child session and no child transcript.
   */
  readonly childWork: 'nested' | 'none';
  /** Hook runs. `reported`: the runner emits hook items (from wire frames or its session
   *  transcript). `none`: hooks run inside the harness with no reported output; a runner declaring
   *  `none` must declare named `R77` and `UI2` exemptions in `runners/<id>/mock.ts`. */
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
  /** Explicit shutdown reaps the process group, or also observed detached descendants.
   * Abrupt leader exit before capture makes no detached-child guarantee. */
  readonly shutdownDescendants: 'process-group' | 'observed-tree';
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

/**
 * Each runner's facts, by runner id. A read goes to the registry (`core/runner-registry.ts`): each
 * runner declares its facts in its definition (`runners/<id>/facts.ts`), the table lists the
 * registered ids, and reading any id resolves it as `resolveRunnerId` does (a legacy id to its
 * runner, an unregistered one to the default runner's definition), so a registered id that is no
 * built-in still reads its own facts.
 */
export const RUNNER_FACTS: Readonly<Record<string, RunnerFacts>> = new Proxy({} as Record<string, RunnerFacts>, {
  get(target, id) {
    if (typeof id !== 'string') return Reflect.get(target, id);
    return runnerDefinition(resolveRunnerId(id)).facts;
  },
  has(_, id) {
    return typeof id === 'string' && knownRunnerIds().includes(id);
  },
  ownKeys() {
    return [...registeredRunners().map(({ id }) => id)];
  },
  getOwnPropertyDescriptor(_, id) {
    if (typeof id !== 'string' || !knownRunnerIds().includes(id)) return undefined;
    return { enumerable: true, configurable: true, writable: false, value: runnerDefinition(id).facts };
  },
  // Read-only, like the frozen table this proxy replaced (review B1): every mutation trap
  // refuses, so no descriptor change, deletion, prototype change or extension can later make a
  // facts read throw a Proxy invariant error.
  set: () => false,
  deleteProperty: () => false,
  defineProperty: () => false,
  setPrototypeOf: () => false,
  preventExtensions: () => false,
});

/** The registered runners whose declared facts match, in registration order. */
export function runnersWhere(matches: (facts: RunnerFacts) => boolean): string[] {
  return registeredRunners().filter(definition => matches(definition.facts)).map(definition => definition.id);
}
