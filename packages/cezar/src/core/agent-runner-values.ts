/**
 * The runtime values of the runner seam (moved from `core/agent-runner.ts`, which holds only
 * types): spec-field and tool-grant tables, the Squawk-side spec support, system-prompt prepend,
 * signal-exit predicates and input-delivery defaults. The types they use stay in
 * `core/agent-runner.ts`.
 */
import type {
  AgentRunSpec,
  AgentRunSpecField,
  AgentRunSpecSupport,
  AgentRunner,
  InputDelivery,
  ToolGrantKind,
  TrackableChild,
} from './agent-runner.ts';

/** The rejection of an agent-input acknowledgement that the session's own `end()` cut off
 *  (hearsay-tools/squawk#3508). Squawk keeps such input owed as a closed-session delivery
 *  failure. A runner raises it only for the abort its `end()` fired: a provider error that
 *  arrived first, even one whose body the close cut off, keeps its own error. */
export class SessionEndedBeforeAcknowledgement extends Error {
  constructor() {
    super('the session ended before the input was acknowledged');
    this.name = 'SessionEndedBeforeAcknowledgement';
  }
}

/** The abort an `AbortController` fires rejects a fetch or a read with this name. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Every `AgentRunSpec` field, as a runtime list. Typed as a full `Record` over
 * `keyof AgentRunSpec`, so the interface gaining or losing a field is a compile
 * error here — and, through `AgentRunSpecSupport`, in every runner (#284).
 */
const AGENT_RUN_SPEC_FIELD_SET: Readonly<Record<keyof AgentRunSpec, true>> = {
  timings: true,
  scope: true,
  systemPrompt: true,
  squawkTools: true,
  userPrompt: true,
  skill: true,
  resumeFallbackSkill: true,
  images: true,
  cwd: true,
  toolGrant: true,
  restrictCrossSessionMessaging: true,
  minimal: true,
  additionalDirectories: true,
  env: true,
  model: true,
  effort: true,
  timeoutMs: true,
  sessionId: true,
  resume: true,
  resumeFallbackSystemPrompt: true,
};
export const AGENT_RUN_SPEC_FIELDS = Object.keys(AGENT_RUN_SPEC_FIELD_SET) as readonly AgentRunSpecField[];

/** Every `ToolGrant` kind, as a runtime list; a `Record`, so a new kind is a compile error here. */
const TOOL_GRANT_KIND_SET: Readonly<Record<ToolGrantKind, true>> = {
  unset: true,
  'step-default': true,
  inherited: true,
  explicit: true,
};
export const TOOL_GRANT_KINDS = Object.keys(TOOL_GRANT_KIND_SET) as readonly ToolGrantKind[];

/** The `default` of a runner's switch over `ToolGrant['kind']`: only a kind it does not map reaches here. */
export function unknownToolGrant(grant: never): never {
  throw new Error(`Unknown tool grant kind: ${String((grant as { kind?: unknown }).kind)}`);
}

/** The spec fields every runner honors the same way: Squawk-side settings that never reach a
 *  native wire. Each runner spreads these into its `specSupport`. */
export const SQUAWK_SIDE_SPEC_SUPPORT = {
  timings: { honored: true, via: 'internal runner deadlines; omitted fields retain production defaults' },
  scope: { honored: true, via: 'every session process starts inside the worker scope (ADR 0032)' },
} as const satisfies Partial<AgentRunSpecSupport>;

/**
 * Backends without a dedicated system-prompt channel (codex app-server,
 * opencode serve) deliver `spec.systemPrompt` as a leading block of the
 * opening user message — the documented per-backend mapping (spec §protocol
 * v2: claude = `--append-system-prompt`, codex/opencode = prepended here).
 */
export function prependSystemPrompt(systemPrompt: string | undefined, userPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
}

/**
 * True for the `128 + signal` exit codes an agent CLI reports when it handles
 * a stop signal itself instead of dying from it (SIGINT/SIGKILL/SIGTERM).
 *
 * Every runner arms a SIGTERM→SIGKILL watchdog on `end()` and signals on
 * `interrupt()` (#703): the CLIs install their own handlers, so a session the
 * runner tore down on purpose comes back as a NON-ZERO exit. Paired with a
 * "we sent the signal" flag, this predicate keeps that teardown out of the
 * error path — an exit Squawk caused is never an agent failure.
 */
export function isSignalTerminationExit(exitCode: number | null): boolean {
  return exitCode === 130 || exitCode === 137 || exitCode === 143;
}

/**
 * Returns a predicate that answers "has this child actually terminated?".
 *
 * `ChildProcess.killed` answers a different question — it flips as soon as a
 * signal is *delivered*, whether or not the child dies from it. Every agent CLI
 * installs its own SIGTERM handler, so gating a SIGTERM→SIGKILL watchdog on
 * `!child.killed` disables the escalation for exactly the child it exists for:
 * `killed` is true, `exitCode` stays null, and the process outlives the whole
 * grace window (#844, same defect fixed for the discovery probe in #841).
 *
 * Seeded from `exitCode`/`signalCode` so a child that died before the watchdog
 * was armed is recognized without waiting for an event that already fired.
 */
export function trackChildExit(child: TrackableChild): () => boolean {
  let exited = child.exitCode != null || child.signalCode != null;
  child.once('exit', () => {
    exited = true;
  });
  return () => exited;
}

export const BOUNDARY_INPUT_DELIVERY: InputDelivery = {
  mode: 'boundary', consumption: 'unobservable', acknowledgement: 'response', humanInputAtTurnEnd: 'always-held', via: 'next idle turn',
};
/** Absent means the pre-#505 behavior every runner had. No shipped runner declares `boundary`;
 *  it remains the delivery of a runner that declares none. */
export function inputDeliveryOf(runner: Pick<AgentRunner, 'inputDelivery'>): InputDelivery {
  return runner.inputDelivery ?? BOUNDARY_INPUT_DELIVERY;
}
