import { registeredRunners, isRegisteredRunner, runnerDefinition } from './runner-registry.ts';
/**
 * Shared fixtures for the harness parity matrix (`harness-parity.test.ts`,
 * spec `.ai/specs/2026-09-04-harness-parity-matrix.md`, #68).
 *
 * `ui-parity.test.ts` pins one axis: every mapper emits every v2 UI capability.
 * This kit supports the other one — the session, lifecycle and error-path
 * contract in `agent-runner.ts` — by driving each backend's REAL runner class
 * against that backend's own offline mock binary.
 *
 * Two deliberate choices live here rather than in the suite:
 *  - **scenario NAMES are shared, spellings are not.** Every mock is already
 *    driven by `mock:<scenario>` markers found in the prompt text, and those
 *    markers were written alongside the golden fixtures. The adapter maps a
 *    shared name onto whatever a backend already calls it, so the matrix
 *    renames nothing and churns no passing runner test.
 *  - **the transport is an explicit `CEZ_*_BIN`, never `CEZ_DRY_RUN`.** A row's
 *    transport is then visible in the adapter instead of implied by a global,
 *    and a backend with no dry-run short-circuit is driven the same way as one
 *    that has it.
 *
 * The run tier, which drives a real `RunManager`, lives in `workflow-parity.testkit.ts`. This
 * kit imports no workflow-engine module, so a runner-adapter test does not load the engine
 * (hearsay-tools/cezarion#2938); `harness-parity-closure.test.ts` holds it to that.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WAIT_KIND } from '@open-mercato/cezar-contract/wait-factories.testkit';
import type { AgentRunSpec, AgentEvent, AgentRunResult, AgentSession, SessionOptions } from './agent-runner.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import type { RunnerFacts } from './runner-facts.ts';
import type { RunnerDefinition, RunnerMock } from './runner-definition.ts';

import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';
import type { UiEvent } from './ui-events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The shared scenario catalog. A name, not a marker.
 *
 * | Scenario | The mock must |
 * | --- | --- |
 * | `baseline` | one text, one tool call and result, a later visible assistant message, usage, then its terminal turn signal |
 * | `mcp-approval` | ask the native client before another MCP server's tool call, then echo the exact answer and end the turn |
 * | `cezar-done` | the same, calling `cezar_done` before its final text so the run reaches its review gate |
 * | `hold` | delay the terminal turn signal after the last content event |
 * | `hold-cezar-done` | like `hold`, then call `cezar_done` so a mid-turn follow-up can race the close (#486) |
 * | `hold-cezar-ask` | like `hold`, then call `cezar_ask` so a mid-turn follow-up can race the park (#486) |
 * | `provider-error` | a request the provider rejects as invalid (HTTP 400) in its native error shape; the run fails |
 * | `provider-error-controlled` | the same 400, raised by the mock's failure control (`failure: 'provider'`) |
 * | `provider-unavailable` | the provider is unreachable or answers 503 (Codex: its own stream retries); the run holds |
 * | `provider-rate-limit` | a 429 with no reset time in its native error shape; the run holds |
 * | `provider-not-found` | a 404 from the model endpoint in its native error shape; the run holds |
 * | `provider-credit` | a spent credit balance in its native error shape; the run holds |
 * | `approval` | a native permission request Squawk routes to the cockpit; no turn end until it is answered |
 * | `permission-default` | a native built-in default permission ask Squawk answers itself, then call `cezar_done` (#1266) |
 * | `approval-resolved` | the `approval` request, which the backend settles itself once `CEZ_MOCK_RELEASE_FILE` exists, then `cezar_done` |
 * | `approval-turn-end` | the `approval` request, still pending when the turn ends after `cezar_done` once `CEZ_MOCK_RELEASE_FILE` exists |
 * | `approval-reply-fails` | the `approval` request, whose first answer the backend refuses to accept; a later answer ends the turn |
 * | `approval-malformed` | a malformed native permission request; the backend calls `cezar_done` and ends the turn once it is refused |
 * | `permission-classify` | a request the backend settles while Squawk reads its config, then a marker request (`CEZ_MOCK_RELEASE_FILE` gates) |
 * | `permission-late` | the turn ends after `cezar_done`, then a native permission request from a run the server started; its answer resumes that run, which calls `cezar_done` |
 * | `ask` | an ask — native where the wire has one (Codex, OpenCode), a `cezar_ask` call (`mock:cezar-ask`) otherwise |
 * | `ask-resume` | accept one human answer, then call `cezar_done` without another prompt (`mock:resume-cezar-done`) |
 * | `cezar-ask` | call `cezar_ask` with one "Which test library?" question, then end the turn — the same tool call on every wire, fresh or resumed |
 * | `cezar-wait` | call `cezar_wait` for a 60 s timer, then end the turn — a declared monitoring park on every wire |
 * | `ask-reply-late` | native ask whose reply acknowledgement can lag the resumed turn |
 * | `ask-bad` | a malformed native ask, and then still end the turn (the runners with no native ask have none) |
 * | `subagent` | child work and terminal signal, then parent text after a `cezar_wait` timer, followed by late child text |
 * | `forked-skill` | a skill call that runs as a native forked subagent: child work nested under the call, then its result and final text |
 * | `hook-after-park` | a mid-turn hook with context, a `cezar_wait` park, then a late hook (#961) |
 * | `steer-tool` | one slow tool; agent input sent while it runs is read before the turn ends (#505) |
 * | `steer-late` | the final text first; agent input sent after it arrives after the last model call (#505) |
 * | `silent-tail` | visible assistant text, a tool, then reasoning that names cezar_done, and no later message |
 * | `silent-tail-ack-delay` | silent-tail as a follow-up whose transport ACK is held until after turn-end |
 * | `silent-tail-no-reply` | the same first turn; a final-message nudge is ACKed and never opens a turn |
 * | `silent-tail-late-reply` | the same first turn; a final-message nudge is ACKed, then replies after the bound |
 * | `silent-tail-late-turn-start` | the same first turn; after the bound, native turn-start holds before any content |
 * | `silent-tail-slow-done` | the same first turn; a nudge reply starts before the bound and ends after it |
 * | `autonomous-silent` | an autonomous first turn with no done; its nudge is ACKed and answered with heartbeats only |
 * | `serve-start-exit` | the backend server's first start exits before listening; the next start answers `baseline` |
 *
 * hearsay-tools/cezarion#2397 removed the lifecycle markers, and with them the scenarios that
 * drove marker parsing only (`split-text`, `ask-snapshot`, `ask-snapshot-bad`, `ask-prose`).
 */
export const SCENARIOS = [
  'approval',
  'permission-default',
  'approval-resolved',
  'approval-turn-end',
  'approval-reply-fails',
  'approval-malformed',
  'permission-classify',
  'permission-late',
  'mcp-approval',
  'multi-pr-refs',
  'auto-resumed',
  'turn-messages',
  'skill-warning',
  'closed-input',
  'input-closed-live',
  'missing-binary',
  'serve-start-exit',
  'crash-stderr-pre-ack',
  'crash-stderr-held-pipe',
  'shutdown-stderr',
  'crash-stderr',
  'crash-stderr-single',
  'autonomous',
  'autonomous-cap',
  'autonomous-cezar-ask-cap',
  'autonomous-silent',
  'silent-tail',
  'silent-tail-ack-delay',
  'silent-tail-no-reply',
  'silent-tail-late-reply',
  'silent-tail-late-turn-start',
  'silent-tail-slow-done',
  'baseline',
  'cezar-done',
  'hold',
  'hold-gated',
  'hold-cezar-done',
  'hold-cezar-ask',
  'no-progress',
  'no-progress-ignore-term',
  'no-progress-held-pipe',
  'no-progress-ack-only',
  'no-progress-leftover',
  'busy-progress',
  'provider-error',
  'provider-error-controlled',
  'provider-unavailable',
  'provider-rate-limit',
  'provider-not-found',
  'provider-credit',
  'post-success-refusal',
  'ask',
  'ask-resume',
  'ask-bad',
  'ask-reply-late',
  'cezar-ask',
  'cezar-wait',
  'subagent',
  'subagent-after-park',
  'forked-skill',
  'hook-after-park',
  'steer-tool',
  'steer-late',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/** hearsay-tools/cezarion#843: real OS failures after each native prompt is admitted. */
export const SHUTDOWN_CRITERIA = [
  { id: 'S22', scenario: 'no-progress', name: 'treats an outside signal as failure' },
  { id: 'S23', scenario: 'no-progress', name: 'end escalates when the child cannot process EOF or SIGTERM' },
  { id: 'S24', scenario: 'no-progress', name: 'stops the live child when its output transport fails' },
  // hearsay-tools/cezarion#890: the session leader's own process group.
  { id: 'S26', scenario: 'no-progress-leftover', name: 'the session leader leads its own process group' },
  { id: 'S27', scenario: 'no-progress-leftover', name: "stop ends the leader's process group but not a setsid child" },
  { id: 'S28', scenario: 'no-progress-leftover', name: 'end escalation reaches the whole process group' },
  { id: 'S29', scenario: 'input-closed-live', name: 'settles a live native input transport failure without false success' },
  // hearsay-tools/cezarion#1286: a session that ends without a signal from Squawk.
  { id: 'S30', scenario: 'no-progress-leftover', name: 'a leader that exits on its own leaves nothing in its process group' },
  { id: 'S31', scenario: 'no-progress-leftover', name: 'a leader killed from outside leaves nothing in its process group' },
  { id: 'S33', scenario: 'no-progress', name: 'preserves outside-signal failure when native exit notification follows EOF cleanup' },
  { id: 'S34', scenario: 'no-progress', name: 'preserves delayed outside-signal failure when all process probes are unavailable' },
] as const;

/** hearsay-tools/cezarion#1351: earlier success must not swallow a later native rejection. */
export const MODEL_REFUSAL_CRITERIA = [
  { id: 'S32', scenario: 'post-success-refusal', name: 'bounds a provider refusal after prior success and retains its diagnosis' },
] as const;

/** #427: intermediate asks through cezar_ask, on every native message wire. Q2 (a malformed
 *  intermediate marker) went with the CEZ:ASK line (hearsay-tools/cezarion#2397). */
export const WORKFLOW_ASK_CRITERIA = [
  { id: 'Q4', scenario: 'cezar-ask', name: 'idle close, a second question on Continue and a clean close before its answer retain the workflow tail' },
  { id: 'Q5', scenario: 'cezar-ask', name: 'restart preserves the unanswered question and resumes the tail after an answer' },
  { id: 'Q6', scenario: 'cezar-ask', name: 'cancel leaves later steps pending' },
  { id: 'Q8', scenario: 'cezar-ask', name: 'an authored timeout fails without running later steps' },
] as const;

/** hearsay-tools/cezarion#1620: workflow-step-completion-parity.testkit.ts, every native wire. An
 *  earlier agent step completes only on an accepted done; the tail never starts without one. */
export const STEP_COMPLETION_CRITERIA = [
  { id: 'C1', scenario: 'baseline', name: 'an earlier step without done is nudged once, then waits for the user; a reply with done runs the tail' },
  { id: 'C3', scenario: 'baseline', name: 'a clean session close without done leaves the earlier step waiting; Continue with done runs the tail' },
  { id: 'C4', scenario: 'baseline', name: 'an idle close leaves the earlier step waiting; a Continue without done parks on it again' },
  { id: 'C5', scenario: 'baseline', name: 'restart recovery keeps the parked earlier step; Continue with done runs the tail' },
  { id: 'C6', scenario: 'autonomous', name: 'an autonomous earlier step is nudged to its done, then the tail runs' },
  { id: 'C7', scenario: 'baseline', name: 'a worktree setup that fails before the tail keeps its position across a restart; the repair Continue with done runs the tail once' },
] as const;

/** #470: exercised in workflow-timeout-parity.testkit.ts against every native wire. */
// T1, T2 and T5 hold their turn and then signal done, which an earlier step needs
// since hearsay-tools/cezarion#1620.
export const WORKFLOW_TIMEOUT_CRITERIA = [
  { id: 'T1', scenario: 'hold-cezar-done', name: 'default non-final steps outlive the runner deadline' },
  { id: 'T2', scenario: 'hold-cezar-done', name: 'explicit zero disables the workflow deadline' },
  { id: 'T3', scenario: 'hold', name: 'authored positive deadlines fail without running trailing checks' },
  { id: 'T4', scenario: 'hold', name: 'standalone sessions retain the default deadline' },
  { id: 'T5', scenario: 'hold-cezar-done', name: 'an authored longer limit replaces the runner default' },
  { id: 'T6', scenario: 'hold', name: 'default tasks remain unlimited' },
  { id: 'T7', scenario: 'hold', name: 'a set spec.timeoutMs replaces the runner default deadline' },
] as const;

export const NO_PROGRESS_CRITERIA = [
  { id: 'N1', scenario: 'no-progress', name: 'stalled nonfinal turns fail and release capacity' },
  { id: 'N2', scenario: 'busy-progress', name: 'native progress keeps a long turn alive' },
  { id: 'N3', scenario: 'baseline', name: 'parked sessions outlive inactivity and followups rearm it' },
  { id: 'N5', scenario: 'no-progress-ignore-term', name: 'stalled processes ignoring TERM are killed before releasing capacity' },
  { id: 'N6', scenario: 'ask', name: 'native questions or cezar_ask pause protection until answered' },
  { id: 'N7', scenario: 'no-progress-held-pipe', name: 'descendant-held pipes cannot retain capacity after CLI exit' },
  { id: 'N8', scenario: 'no-progress-ack-only', name: 'agent input rearms protection even without a native turn-start notification' },
  { id: 'N4', scenario: 'baseline', name: 'Continue sessions enforce inactivity' },
] as const;

/** #486: workflow-followup-cells.testkit.ts, real native wires on both turn-end paths. */
export const FOLLOWUP_CRITERIA = [
  { id: 'H1', scenario: 'hold-cezar-done', name: 'keeps a mid-turn human follow-up across a cezar_done turn' },
  { id: 'H2', scenario: 'hold-cezar-ask', name: 'drops a mid-turn human follow-up when the turn parks on cezar_ask' },
  { id: 'H3', scenario: 'hold-gated', name: 'does not park or nudge between a done-less turn and a mid-turn follow-up' },
  { id: 'H4', scenario: 'hold-gated', name: 'does not park before a held follow-up whose native turn starts late' },
  { id: 'H5', scenario: 'hold-gated', name: 'does not park before a late-acknowledged steer that runs after the turn' },
] as const;

/** #426: workflow-autonomous-parity.testkit.ts, real native wires on both turn-end paths. */
export const AUTONOMOUS_CRITERIA = [
  { id: 'A1', scenario: 'autonomous', name: 'nudges fresh markerless turns to completion' },
  { id: 'A2', scenario: 'autonomous', name: 'hydrates autonomous Continue sessions' },
  { id: 'A3', scenario: 'cezar-ask', name: 'refuses cezar_ask on fresh turns and nudges to completion' },
  { id: 'A4', scenario: 'cezar-ask', name: 'refuses cezar_ask on Continue and nudges to completion' },
  { id: 'A5', scenario: 'autonomous-cap', name: 'parks at the cap with an explicit note' },
  { id: 'A6', scenario: 'autonomous', name: 'keeps non-autonomous parking reachable' },
  { id: 'A7', scenario: 'cezar-wait', name: 'parks on a cezar_wait timer without a nudge' },
  { id: 'A8', scenario: 'cezar-done', name: 'honors cezar_done without a nudge' },
  { id: 'A9', scenario: 'ask', name: 'preserves native mid-turn questions' },
  { id: 'A10', scenario: 'cezar-ask', name: 'never continues past a persisted unanswered question' },
  { id: 'A11', scenario: 'autonomous-cezar-ask-cap', name: 'continues after a refused cezar_ask and delayed readiness' },
  { id: 'A12', scenario: 'autonomous-cezar-ask-cap', name: 'continues a resumed refused cezar_ask after delayed readiness' },
  { id: 'A13', scenario: 'hold-gated', name: 'keeps a refused nudge running until the idle bound, then settles waiting' },
  { id: 'A14', scenario: 'hold-gated', name: 'keeps a refused nudge on a Continue running until the idle bound, then settles waiting' },
  { id: 'A15', scenario: 'autonomous-cap', name: 'bounds a nudge whose acknowledgement never arrives, then settles waiting' },
  { id: 'A16', scenario: 'autonomous-silent', name: 'bounds an acknowledged nudge that gets only heartbeats, then settles waiting' },
] as const;

/** #544: workflow-final-message-cells.testkit.ts, the no-wait nudge's reply bound on every native wire. */
export const FINAL_MESSAGE_CRITERIA = [
  { id: 'F7', scenario: 'silent-tail-ack-delay', name: 'nudges a silent tail after a delayed ACK' },
  { id: 'F8', scenario: 'silent-tail-no-reply', name: 'parks waiting when a nudge is ACKed without a turn' },
  { id: 'F9', scenario: 'silent-tail-late-reply', name: 'resumes when a nudge reply arrives after the bound' },
  { id: 'F10', scenario: 'silent-tail-slow-done', name: 'content that starts before the bound clears it' },
  { id: 'F11', scenario: 'silent-tail-late-turn-start', name: 'resumes on a late native turn-start before content' },
] as const;

/** hearsay-tools/cezarion#1138: worker-wait-conversations.test.ts, every native parent wire. */
export const WORKER_PROGRESS_WAIT_CRITERIA = [
  { id: 'WP1', scenario: 'hold', name: 'delivers progress without retiring the registered worker wait' },
  { id: 'WP2', scenario: 'hold', name: 'preserves a resumed request past 45 minutes and delivers a late reply amendment' },
] as const;

/** #790: skill system prompt on Continue and restart recovery, every native wire. */
export const SKILL_RESUME_CRITERIA = [
  { id: 'R53', scenario: 'baseline', name: 'keeps the skill system prompt on Continue' },
  { id: 'R54', scenario: 'baseline', name: 'keeps the skill system prompt when recover() resumes a persisted continuation' },
  { id: 'R55', scenario: 'baseline', name: 'warns once when a resent continued skill is gone' },
  { id: 'R56', scenario: 'baseline', name: 'declares systemPromptOnResume matching the resume wire' },
  { id: 'R57', scenario: 'baseline', name: 'reuses the recorded session id on Continue and recover' },
  { id: 'R59', scenario: 'baseline', name: 'recovers a continued session before its next session event' },
] as const;

/** hearsay-tools/cezarion#1408: the selected skill and its companions reach every runner's task worktree. */
export const SKILL_PROVISION_CRITERIA = [
  { id: 'R92', scenario: 'baseline', name: 'starts the selected skill natively with opening context and no injected body' },
  { id: 'R93', scenario: 'baseline', name: "refuses a missing selected id before a model call" },
  { id: 'R94', scenario: 'baseline', name: 'refuses an ambiguous selected id and names every listed path' },
  { id: 'R95', scenario: 'baseline', name: 'turns a typed name into a native trigger without provisioning files' },
  { id: 'R96', scenario: 'baseline', name: 'Stop during native list discovery launches no session' },
] as const;

/** hearsay-tools/cezarion#917: worktree setup's note reaches every runner's opening message. */
export const WORKTREE_SETUP_CRITERIA = [
  { id: 'R58', scenario: 'baseline', name: 'delivers the worktree setup note in the opening message' },
] as const;

/** hearsay-tools/cezarion#935: conversation-answer-delivery.testkit.ts, a Continue executing a human answer. */
export const ANSWER_DELIVERY_CRITERIA = [
  { id: 'I3', scenario: 'steer-tool', name: 'steers a conversation message into a running human answer and reports it read before that turn ends' },
  { id: 'I4', scenario: 'hold-gated', name: 'delivers a conversation message to a running human answer as its input delivery declares' },
  { id: 'I5', scenario: 'cezar-ask', name: 'holds conversation input behind a native question and delivers it beside a cezar_ask one, never as its answer' },
] as const;

/** Native approvals, exercised through the manager and HTTP route (P1), and a backend's own
 *  built-in permission asks, which Squawk answers without parking (P2, hearsay-tools/cezarion#1266).
 *  P3–P8 pin the pending request's lifecycle: it holds from receipt until the backend settles it.
 *  P9 routes an MCP tool approval for another server (hearsay-tools/cezarion#1294). */
export const PERMISSION_CRITERIA = [
  { id: 'P1', scenario: 'approval', name: 'routes explicit native approval decisions and settles the turn' },
  { id: 'P2', scenario: 'permission-default', name: "answers a backend's built-in default permission ask without parking" },
  { id: 'P3', scenario: 'approval-resolved', name: 'retires a pending native request the backend settles itself' },
  { id: 'P4', scenario: 'approval-turn-end', name: 'retires a native request still pending when its turn ends' },
  { id: 'P5', scenario: 'approval-reply-fails', name: 'keeps a native request answerable when its answer is not accepted' },
  { id: 'P6', scenario: 'approval-malformed', name: 'refuses a malformed native request instead of hanging on it' },
  { id: 'P7', scenario: 'permission-classify', name: 'holds agent input from receipt and shows no card for a request settled before it' },
  { id: 'P8', scenario: 'permission-late', name: 'reopens the turn for a request that arrives after it ended, and closes the session once it is answered' },
  { id: 'P9', scenario: 'mcp-approval', name: 'routes an MCP tool approval for another server and settles the turn (hearsay-tools/cezarion#1294)' },
] as const;

export interface HarnessAdapter {
  readonly backend: string;
  /** Every human ask wire this runner exposes; cezar_ask when it has no native one. */
  readonly askResumeCases: readonly {
    kind: string;
    scenario: 'ask-resume';
    answer: string;
  }[];
  /** The env var this backend's runner already reads to locate its binary. */
  readonly binEnv: string;
  /** Absolute path to the offline mock binary. */
  readonly mockBin: string;
  /** Scenario name -> the prompt text this backend's mock answers it with. */
  readonly scenarios: Readonly<Partial<Record<ScenarioName, string>>>;
  /** P1: the option to pick (matched case-insensitively against its label) and the text the
   *  mock echoes once that native reply arrives. Required with `scenarios.approval`. */
  readonly approvalDecisions?: readonly { pick: string; echo: string }[];
  /** P6: the text the mock echoes once Squawk refuses its malformed request. Required with
   *  `scenarios['approval-malformed']`. */
  readonly malformedApprovalEcho?: string;
  /** P7: the text the mock sends once it settled its own early approval request (`mock.selfSettledApprovalEcho`). */
  readonly selfSettledApprovalEcho?: string;
  /** Where the mock keeps the sessions it resumes (`mock.sessionStore`); absent when it resumes any id. */
  readonly sessionStore?: { readonly env: string; readonly argsFileSuffix: string };
  /** How a resume reaches a session the mock does not hold (`mock.missingSession`). */
  readonly missingSession?: RunnerMock['missingSession'];
  /** The variables the mock reads for a scenario no prompt can drive (`mock.scenarioEnv`). */
  readonly scenarioEnv?: RunnerMock['scenarioEnv'];
}

/** `mock:cezar-tool` (scripts/mock-ci-tool.mjs) calls one Squawk tool over the session's own wire,
 *  then `mock:then` ends the turn with that text. Every mock answers it the same way, on a fresh
 *  turn and on a resumed one, so `cezar-ask` and `cezar-wait` are one prompt for every runner. */
const squawkToolPrompt = (name: 'cezar_ask' | 'cezar_wait', args: Record<string, unknown>, then: string): string =>
  `mock:cezar-tool ${name} ${Buffer.from(JSON.stringify(args)).toString('base64url')} mock:then ${Buffer.from(then).toString('base64url')}`;
/** The question every `cezar-ask` turn sends. */
export const SQUAWK_ASK_QUESTION = 'Which test library?';
const SQUAWK_ASK_PROMPT = squawkToolPrompt('cezar_ask', {
  context: 'A choice is needed before I continue.',
  questions: [{ header: 'Library', question: SQUAWK_ASK_QUESTION, options: [{ label: 'Vitest' }, { label: 'Node test' }] }],
}, 'Pick one.');
const SQUAWK_WAIT_PROMPT = squawkToolPrompt('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'Re-check the downstream work.' },
  'parity cezar-wait: waiting on downstream work');
const SQUAWK_TOOL_SCENARIOS = { 'cezar-ask': SQUAWK_ASK_PROMPT, 'cezar-wait': SQUAWK_WAIT_PROMPT } as const;

/** The id Squawk pins on every session, mirroring `RunManager`. */
export const PINNED_SESSION_ID = '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90';

/** Pre-create a session `backend`'s mock will find on resume, when its mock resumes only a session
 *  it knows (`mock.sessionStore`), so a Continue cell resumes it instead of taking the 404 fallback
 *  that starts a fresh session. A mock that resumes any id needs no seed: this does nothing. */
export function seedMockSession(
  backend: string,
  argsFile: string,
  session: { id?: string; title?: string; permission?: unknown[] } = {},
): void {
  const store = HARNESS_ADAPTERS[backend]!.sessionStore;
  if (!store) return;
  const id = session.id ?? PINNED_SESSION_ID;
  writeFileSync(`${argsFile}${store.argsFileSuffix}`, JSON.stringify({
    seq: 1,
    sessions: {
      [id]: {
        id,
        title: session.title ?? 'cezar task',
        prompts: [],
        ...(session.permission ? { permission: session.permission } : {}),
      },
    },
  }));
}

/** The adapter of each runner, read once from its definition's `mock` part. */
const adapters = new WeakMap<RunnerDefinition, HarnessAdapter>();

/**
 * The adapter a runner's `mock` part declares (`runners/<id>/mock.ts`). The kit adds the
 * `cezar-ask` and `cezar-wait` prompts, which every mock answers the same way.
 */
export function harnessAdapter(definition: RunnerDefinition): HarnessAdapter {
  let adapter = adapters.get(definition)!;
  if (!adapter) {
    const { mock } = definition;
    adapter = {
      backend: definition.id,
      askResumeCases: mock.askResumeCases,
      binEnv: mock.binEnv,
      mockBin: join(HERE, '..', '..', 'scripts', mock.script),
      scenarios: { ...SQUAWK_TOOL_SCENARIOS, ...mock.scenarios },
      ...(mock.approvalDecisions ? { approvalDecisions: mock.approvalDecisions } : {}),
      ...(mock.malformedApprovalEcho !== undefined ? { malformedApprovalEcho: mock.malformedApprovalEcho } : {}),
      ...(mock.selfSettledApprovalEcho !== undefined ? { selfSettledApprovalEcho: mock.selfSettledApprovalEcho } : {}),
      ...(mock.sessionStore ? { sessionStore: mock.sessionStore } : {}),
      ...(mock.missingSession ? { missingSession: mock.missingSession } : {}),
      ...(mock.scenarioEnv ? { scenarioEnv: mock.scenarioEnv } : {}),
    };
    adapters.set(definition, adapter);
  }
  return adapter;
}

/**
 * Each registered runner's adapter, by runner id. A read goes to the registry: a test registers the
 * runners it drives (`useRunners` and `onlyRunner`), and reading a runner that is not registered
 * throws, never returns undefined. `Object.values` lists the registered runners.
 */
export const HARNESS_ADAPTERS: Readonly<Record<string, HarnessAdapter>> = new Proxy({} as Record<string, HarnessAdapter>, {
  get: (_target, key) => typeof key === 'string' ? harnessAdapter(runnerDefinition(key as string)) : undefined,
  has: (_target, key) => typeof key === 'string' && isRegisteredRunner(key),
  ownKeys: () => registeredRunners().map(definition => definition.id),
  getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && isRegisteredRunner(key)
    ? { enumerable: true, configurable: true, value: harnessAdapter(runnerDefinition(key as string)) } : undefined,
});

/** The prompt text that drives one backend's mock into one shared scenario. */
export function promptFor(backend: string, scenario: ScenarioName): string {
  const prompt = HARNESS_ADAPTERS[backend]!.scenarios[scenario]!;
  if (prompt === undefined) {
    throw new Error(`${backend} declares no prompt for scenario "${scenario}"`);
  }
  return prompt;
}

/**
 * Why a cell is exempt, which decides how the matrix pins it. Both kinds fail
 * the day the backend gains the thing, which is what keeps an exemption from
 * going stale — they just cannot be pinned the same way.
 *
 * - `capability-absent` — the scenario IS constructible on this wire, the
 *   backend simply does not produce the criterion's signal. Pinned by an
 *   INVERTED assertion: the criterion must not hold.
 * - `scenario-unconstructible` — the wire cannot even create the situation, so
 *   there is nothing to invert (an unrelated baseline turn would satisfy some
 *   criteria by accident). Pinned by requiring the adapter to declare NO prompt
 *   for that scenario, so the day a mock answers it the exemption fails and the
 *   row has to go live.
 */
export type ExemptionKind = 'capability-absent' | 'scenario-unconstructible';

export interface ParityExemption {
  /** The criterion's stable id — `S9`, `R3`. */
  readonly criterion: string;
  readonly backend: string;
  readonly kind: ExemptionKind;
  /** Why this backend's WIRE cannot carry it. Never "not implemented yet". */
  readonly reason: string;
}

interface FactExemptionRule {
  readonly criterion: string;
  readonly kind: ExemptionKind;
  readonly matches: (facts: RunnerFacts, mock?: RunnerMock) => boolean;
  readonly reason: (backend: string) => string;
}

/**
 * Cells a backend's upstream protocol genuinely cannot carry, derived from its declared facts
 * (hearsay-tools/cezarion#2991) or single-runner wire quirks.
 *
 * An entry here is not a waiver — see `ExemptionKind` for how each is pinned.
 * "Not implemented yet" is never a reason: that is a failing row, and the fix
 * is the runner, not this table.
 */
const FACT_EXEMPTION_RULES: readonly FactExemptionRule[] = [
  {
    criterion: 'P1', kind: 'scenario-unconstructible',
    matches: facts => facts.nativePermission === 'none',
    reason: backend => `${backend}'s native wire does not carry a native permission request that Squawk answers through the cockpit permission card. This cell checks that native request/response protocol; ordinary human questions remain covered by R26.`,
  },
  {
    criterion: 'P2', kind: 'scenario-unconstructible',
    matches: facts => facts.nativePermission === 'none',
    reason: backend => `${backend}'s native wire carries no permission request at all, so there is no built-in default ask for Squawk to answer.`,
  },
  ...([
    ['P3', 'for the backend to settle itself'],
    ['P4', 'to outlive its turn'],
    ['P5', 'whose answer the backend could refuse'],
    ['P6', 'to arrive malformed'],
    ['P7', 'to hold input while Squawk classifies it'],
    ['P8', 'to arrive after its turn ended'],
  ] as const).map(([criterion, situation]): FactExemptionRule => ({
    criterion, kind: 'scenario-unconstructible',
    matches: facts => facts.nativePermission === 'none',
    reason: backend => `${backend}'s native wire does not carry a native permission request that Squawk answers through the cockpit permission card, so there is no pending request ${situation}.`,
  })),
  {
    criterion: 'P8', kind: 'scenario-unconstructible',
    matches: facts => facts.nativePermission === 'in-turn',
    reason: () => 'This wire sends a permission request only inside the turn it names, so none can arrive after that turn completed.',
  },
  // S9/R12/R15: a child session's work exists only where the wire nests it under its parent call.
  {
    criterion: 'S9', kind: 'scenario-unconstructible',
    matches: facts => facts.childWork === 'none',
    reason: () => 'This wire carries no child session: a native subagent is a plain tool call on the parent session, so no child terminal signal exists that could end the parent turn.',
  },
  {
    criterion: 'R12', kind: 'scenario-unconstructible',
    matches: facts => facts.childWork === 'none',
    reason: () => 'This wire carries no child session or child transcript, so no child message can arrive between the parent cezar_wait call and turn end.',
  },
  {
    criterion: 'R15', kind: 'scenario-unconstructible',
    matches: facts => facts.childWork === 'none',
    reason: () => 'This wire carries no child session or child transcript, so no child item can arrive after the parent parks.',
  },
  {
    criterion: 'S25', kind: 'scenario-unconstructible',
    matches: facts => facts.transport === 'stdio',
    reason: () => 'This runner speaks its native wire over the spawned process\'s stdio, so there is no listen phase between spawn and session: a start that exits before listening cannot be constructed, and an early exit is the crash path (S15–S18). hearsay-tools/cezarion#872 retries only a server start; stdio process starts are out of scope.',
  },
  {
    criterion: 'S21', kind: 'scenario-unconstructible',
    matches: (_facts, mock) => mock?.implicitAutoResume !== true,
    reason: () => 'This native wire has no implicit autoResume history restoration signal at start. Fresh/start and explicit resume remain covered by S1/S3/S14 and spec-support rows.',
  },
  // R44/R45: a recoverable skill diagnostic is a server-wide session.error that names no session.
  ...(['R44', 'R45'] as const).map((criterion): FactExemptionRule => ({
    criterion, kind: 'scenario-unconstructible',
    matches: facts => facts.transport === 'stdio',
    reason: () => 'This wire speaks over the spawned process\'s stdio, so it has no server-wide unscoped session.error: the UnknownError skill diagnostics of a server wire (an unreadable skill file, or a skill with malformed YAML frontmatter) have no equivalent on it. R2/R46 retain native provider failure coverage.',
  })),
  {
    criterion: 'H2', kind: 'capability-absent',
    matches: facts => facts.inputDelivery.humanInputAtTurnEnd !== 'always-held',
    reason: () => 'This wire writes or steers a mid-turn human follow-up immediately; discardQueuedMessages cannot unwrite it. A runner that holds every mid-turn human message until the turn ends queues and drops it (H2 live rows).',
  },
  {
    criterion: 'F7', kind: 'scenario-unconstructible',
    matches: facts => facts.transport === 'stdio',
    reason: () => 'This wire has no separate HTTP ACK retained after turn completion. Turn frames and the transport ACK share one stream, so a silent-tail turn cannot end while its agent-input ACK is still pending.',
  },
  {
    criterion: 'F11', kind: 'scenario-unconstructible',
    matches: facts => facts.turnStart !== 'on-wire',
    reason: () => 'This wire has no native turn-start frame that reaches v2 after the nudge is sent; turn.started is synthetic at nudge write or dispatch, before any late wire frame.',
  },
  // S11 (hearsay-tools/cezarion#2397): these wires have no answerable native ask; the `ask`
  // scenario calls cezar_ask, whose human wait the workflow holds input behind (R6), not the runner.
  {
    criterion: 'S11', kind: 'capability-absent',
    matches: facts => facts.nativeAsk !== 'answerable',
    reason: () => 'this wire has no native ask; cezar_ask is the workflow\'s human wait, so the runner admits non-human input and the run tier holds it (R6)',
  },
  // R4: a malformed question is a native ask's failure. cezar_ask validates its arguments and
  // answers the agent with invalid_request, so no malformed question reaches the run.
  {
    criterion: 'R4', kind: 'scenario-unconstructible',
    matches: facts => facts.nativeAsk === 'none',
    reason: () => 'this wire has no native ask; a malformed cezar_ask is refused to the agent as invalid_request before any card exists',
  },
  // hearsay-tools/cezarion#1233 U7: cezar_wait stays live on every wire; only a declared native
  // timer tool (Claude's ScheduleWakeup, the Antigravity CLI's schedule) is an alias.
  {
    criterion: 'U7', kind: 'capability-absent',
    matches: facts => facts.nativeTimerTool === null,
    reason: () => 'this wire has no native timer tool',
  },
  // U7h (hearsay-tools/cezarion#1234): the ask scenario on these wires calls cezar_ask, so its
  // human wait opens through cezar_ask rather than a native ask; the cell asserts that instead.
  {
    criterion: 'U7h', kind: 'capability-absent',
    matches: facts => facts.nativeAsk !== 'answerable',
    reason: () => 'this wire has no native ask; its ask scenario calls cezar_ask',
  },
];

/** Criteria each runner must declare in `runners/<id>/mock.ts` exactly when its facts match. */
const REQUIRED_DECLARED_EXEMPTIONS: ReadonlyArray<readonly [string, (facts: RunnerFacts) => boolean]> = [
  // A9: a native mid-turn ask.requested exists only where the declared native ask is answerable.
  ['A9', facts => facts.nativeAsk !== 'answerable'],
  // R77 & UI2: hook telemetry exists only where hookEvents is 'reported'; a runner declaring 'none'
  // must name its wire gap explicitly in runners/<id>/mock.ts rather than self-exempting via facts.
  ['R77', facts => facts.hookEvents === 'none'],
  ['UI2', facts => facts.hookEvents === 'none'],
];

/** Whether a runner's human-prompt hold ends when the wire reports the prompt read, before the
 *  prompt's acknowledgement (`humanPromptHold`). */
export function releasesHumanPromptOnRead(facts: RunnerFacts): boolean {
  return facts.humanPromptHold === 'consumption';
}

/** The registered runners whose human-prompt hold ends when the wire reports the prompt read. */
export function humanPromptReadReleases(): string[] {
  return registeredRunners().filter(def => releasesHumanPromptOnRead(def.facts)).map(def => def.id);
}

/** Build the all-runner `PARITY_EXEMPTIONS` table and verify required declared exemptions. */
export function buildParityExemptions(
  factsById: Readonly<Record<string, RunnerFacts>>,
  mocksById: Readonly<Record<string, RunnerMock>>,
): ParityExemption[] {
  const runnerIds = Object.keys(factsById);
  const byFact = FACT_EXEMPTION_RULES.flatMap(rule =>
    runnerIds
      .filter(backend => rule.matches(factsById[backend]!, mocksById[backend]))
      .map(backend => ({ criterion: rule.criterion, backend, kind: rule.kind, reason: rule.reason(backend) })),
  );
  const declared = Object.entries(mocksById).flatMap(([backend, mock]) =>
    Object.entries(mock.parityExemptions ?? {}).map(([criterion, { kind, reason }]) => ({ criterion, backend, kind, reason })),
  );
  for (const [criterion, matches] of REQUIRED_DECLARED_EXEMPTIONS) {
    const selected = runnerIds.filter(backend => matches(factsById[backend]!));
    const hasDeclared = Object.keys(mocksById).filter(backend => mocksById[backend]!.parityExemptions?.[criterion] !== undefined);
    for (const backend of selected.filter(id => !hasDeclared.includes(id))) {
      throw new Error(`${criterion} exempts ${backend} by its declared facts, but runners/${backend}/mock.ts gives no reason`);
    }
    for (const backend of hasDeclared.filter(id => !selected.includes(id))) {
      throw new Error(`runners/${backend}/mock.ts exempts ${backend} from ${criterion}, but its declared facts do not`);
    }
  }
  return [...byFact, ...declared];
}

/** Whether `backend` is exempt from `criterion`, evaluated against its own facts and mock only. */
export function exemptionForFacts(
  criterion: string,
  backend: string,
  facts: RunnerFacts,
  mock?: RunnerMock,
): ParityExemption | undefined {
  for (const rule of FACT_EXEMPTION_RULES) {
    if (rule.criterion === criterion && rule.matches(facts, mock)) {
      return { criterion, backend, kind: rule.kind, reason: rule.reason(backend) };
    }
  }
  const declared = mock?.parityExemptions?.[criterion];
  return declared ? { criterion, backend, kind: declared.kind, reason: declared.reason } : undefined;
}

export function exemptionFor(criterion: string, backend: string): ParityExemption | undefined {
  const definition = runnerDefinition(backend);
  return exemptionForFacts(criterion, backend, definition.facts, definition.mock);
}

/** Poll a condition. Generous on purpose: under a full suite run these share the
 *  machine with hundreds of files, and a tight bound is a flake, not a check. */
export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    const elapsed = Date.now() - start;
    if (elapsed > ms) throw new Error(`waitFor timed out after ${elapsed}ms: ${cond.toString()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `Array.prototype.findLastIndex` is ES2023; this package's lib is ES2022. */
export function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (match(items[i] as T)) return i;
  }
  return -1;
}

/** Every v1 `text` event of a run, folded the way the orchestrator folds a turn. */
export function textEvents(v1: readonly AgentEvent[]): string[] {
  return v1
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text);
}

export interface SeamObservation {
  readonly backend: string;
  readonly elapsedMs: number;
  readonly failure?: Error;
  readonly v1: readonly AgentEvent[];
  readonly v2: readonly UiEvent[];
  readonly result: AgentRunResult;
  /** The spawned backend process pid, as the seam reported it while open. */
  readonly pid: number | undefined;
}

export interface DriveSeamOptions {
  readonly spec?: Partial<AgentRunSpec>;
  readonly sessionOptions?: SessionOptions;
  /** Extra work while the session is live — a follow-up message, an interrupt.
   *  When absent, `driveSeam` waits for the first turn-end or error. */
  readonly whileOpen?: (
    session: AgentSession,
    observed: { v1: readonly AgentEvent[]; v2: readonly UiEvent[] },
  ) => Promise<void>;
  readonly timeoutMs?: number;
  /** Called with each event right after it is recorded, so a row can read session state at the
   *  event's position in the merged stream (hearsay-tools/cezarion#2991). */
  readonly onEvent?: (event: { readonly v1: AgentEvent } | { readonly v2: UiEvent }) => void;
}

/**
 * Drive one backend's real runner class against its own offline mock and collect
 * both event streams plus the settled result.
 *
 * The bin env var is set and restored around the call the same way
 * `pi-runner.test.ts` and `workflows/run.test.ts` already do it, and
 * `CEZ_DRY_RUN` is cleared so the mock named by the adapter is the only
 * transport in play.
 */
export async function driveSeam(
  backend: string,
  scenario: ScenarioName,
  opts: DriveSeamOptions = {},
): Promise<SeamObservation> {
  const started = Date.now();
  const adapter = HARNESS_ADAPTERS[backend]!;
  const savedBin = process.env[adapter.binEnv]!;
  const savedDry = process.env.CEZ_DRY_RUN;
  process.env[adapter.binEnv]! = adapter.mockBin;
  delete process.env.CEZ_DRY_RUN;
  const cwd = mkdtempSync(join(tmpdir(), `cez-parity-${backend}-`));
  // A failed spawn has no native wire. Exercise the real OS boundary through
  // the adapter's binary setting, leaving runtime scenarios on their own mocks.
  if (scenario === 'missing-binary') process.env[adapter.binEnv]! = join(cwd, 'missing-executable');
  const v1: AgentEvent[] = [];
  const v2: UiEvent[] = [];
  let session: AgentSession | undefined;
  let pid: number | undefined;
  try {
    session = (await runnersUnderTest()(backend)).startSession(
      {
        userPrompt: promptFor(backend, scenario),
        cwd,
        toolGrant: UNSET_TOOL_GRANT,
        timeoutMs: opts.timeoutMs ?? 30_000,
        // RunManager always pins one (`workflows/run.ts:2909`), and claude
        // resumes off exactly this value, so a row that omitted it would test
        // a shape no real run ever uses.
        sessionId: PINNED_SESSION_ID,
        // The claude mock writes to these when set; empty keeps a row from
        // touching a handoff file it does not own.
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '',
          // The variables the mock reads for a scenario no prompt can drive (`mock.scenarioEnv`).
          ...Object.fromEntries(Object.entries(adapter.scenarioEnv?.[scenario] ?? {}).map(([name, value]) => [name, value.replaceAll('{cwd}', cwd)])),
        },
        ...opts.spec,
      },
      (event) => { v1.push(event); opts.onEvent?.({ v1: event }); },
      { ...opts.sessionOptions, onUiEvent: (event) => { v2.push(event); opts.onEvent?.({ v2: event }); },
        onPidChange: (nextPid) => { pid = nextPid; opts.sessionOptions?.onPidChange?.(nextPid); } },
    );
    let failure: Error | undefined;
    const settled = session.result.catch((error: unknown): AgentRunResult => {
      failure = error instanceof Error ? error : new Error(String(error));
      return { text: '', toolCalls: [], tokensUsed: 0 };
    });
    pid ??= session.pid;
    if (scenario === 'missing-binary') await settled;
    else if (opts.whileOpen) await opts.whileOpen(session, { v1, v2 });
    else await waitFor(() => v1.some((e) => e.type === 'turn-end' || e.type === 'error'));
    session.end();
    const result = await settled;
    return { backend, v1, v2, result, pid, elapsedMs: Date.now() - started, ...(failure ? { failure } : {}) };
  } finally {
    session?.interrupt();
    if (savedBin === undefined) delete process.env[adapter.binEnv];
    else process.env[adapter.binEnv]! = savedBin;
    if (savedDry !== undefined) process.env.CEZ_DRY_RUN = savedDry;
    rmSync(cwd, { force: true, recursive: true });
  }
}
