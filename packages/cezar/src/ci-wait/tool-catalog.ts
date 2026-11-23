import { agentToolMetadata, enabledAgentTools } from './tool-registry.ts';
import { squawkAskRequestSchema, squawkCancelWaitRequestSchema, squawkDoneRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import { registeredWaitKinds } from '../workflows/run/wait-kind-registry.ts';
import { z } from 'zod';

/**
 * The Anthropic tool API refuses a top-level `oneOf`/`anyOf`/`allOf`, so `cezar_wait` advertises
 * one flat object: every kind's fields side by side, with `kind` as an enum. Each field's bounds
 * come from its kind's own schema; the discriminated union validates on the server.
 */
export function flatWaitInputSchema() {
  const inputs = registeredWaitKinds().flatMap(row => row.inputs ?? []).sort((a, b) => a.order - b.order);
  const properties: Record<string, unknown> = {};
  for (const input of [...inputs].reverse()) Object.assign(properties, input.properties);
  for (const input of inputs) for (const [key, description] of Object.entries(input.descriptions ?? {})) {
    if (key in properties) properties[key] = { ...(properties[key] as object), description };
  }
  properties.kind = { type: 'string', enum: inputs.map(input => input.kind), description: inputs.map(input => input.description).join('; ') };
  return { type: 'object' as const, properties, required: ['kind'], additionalProperties: false };
}

export const waitToolDefinition = {
  name: 'cezar_wait',
  description: `Open a wait on something outside this turn: a GitHub pull request's checks or its merge (kind "pr"), workers you own (kind "worker"), the replies to requests you sent (kind "request"), named peer tasks that may message you or settle (kind "peer"), a timer (kind "timer"), or a background command (kind "process"). End your turn after it answers; Squawk wakes you when any open wait resolves, with its result. A human message wakes you too and closes no wait; only a message from a peer that a peer wait names closes that wait. Several waits can be open at once; the answer lists them. To wait for the user, call cezar_ask. A checks wait wakes with "stuck" when it has observed a check as queued for at least 15 minutes; its result names the checks, queued minutes and recovery. It ends "startup_failure" when a workflow run on the head created no job. A checks observation is not merge approval; only a merge wait's "merged" outcome means the PR merged. Times in the answers, such as \`deadline\`, are UTC. ` +
    // hearsay-tools/cezarion#3097: Codex ends a command's process group when the command returns,
    // so a plain `&` job dies there, and `setsid … & echo $!` prints a dead PID under Claude.
    'kind "process" wakes you when a background command ends. To start one yourself, run ' +
    '`hsq job start <name> -- <command> [args...]` (your instructions give the full command for this session under "Long commands") ' +
    'and pass the `pid` and `exitFile` it prints as `pid` and `exit_file`, so the wake reports the exit code. ' +
    'To end a job early, run `hsq job stop <name>`; never `kill` its `pid`, which leaves its children running. ' +
    `It writes the command's output to the \`log\` file it prints, refuses a name that still runs, and the job outlives this session; Squawk does not stop it. ` +
    `Its files are in $TMPDIR, the task's temp directory, which Squawk keeps across its own restart and, after the task ends, while a job in it runs, so \`hsq job status <name>\` still finds the job after a Continue. ` +
    'For files that must outlive the task, pass `--dir` with a directory you keep; a process wait accepts that job\'s `exitFile` too. ' +
    'Do not start a long command with `&`, `nohup`, `setsid` or your own background-task tool: it can end with the shell call or the session, or leave you a PID that is not the command\'s. ' +
    // A batch that writes its exit file outside $TMPDIR made agents start a watcher to copy it in.
    'For a command that is already running, or that writes its own status file somewhere else, pass only its `pid` and leave `exit_file` out. ' +
    'The wake then reports `exited` without a code: read the command\'s own log or status file after it. ' +
    'Never start a watcher or helper process to copy a file into $TMPDIR. ' +
    'An unchanged repeat names the retained wait. A changed timeout is refused and keeps that wait active; do not cancel it as a duplicate. On an unknown outcome retry the same operation_id and arguments, without a fallback timer.',
  get inputSchema() { return flatWaitInputSchema(); },
};
/**
 * hearsay-tools/cezarion#1234: the user's answer gets its own tool, so its card is required and
 * `cezar_wait` never has to explain a field only one kind takes. hearsay-tools/cezarion#1458: the
 * texts are research task 77dfb5c4's tested ones; on Claude, prose between tool calls may never
 * reach the user, so the content rides in `context`.
 */
export const askToolDefinition = {
  name: 'cezar_ask',
  description: `Ask the user for a decision or missing input. Put the full draft, findings, evidence and option meanings needed for the decision in context. Squawk renders context as Markdown above the question card. The user cannot see your reasoning or rejected tool calls. The question is a short choice, not the place for supporting detail. Each question takes a header of at most ${ASK_LIMITS.header} characters, a short question of at most ${ASK_LIMITS.question} characters, and ${ASK_LIMITS.minOptions}–${ASK_LIMITS.maxOptions} options shown as choices; leave the options out to let the user type the answer. The user can always type a reply of their own. Other open waits keep running while you wait. Then end your turn; the user's answer wakes you.`,
  inputSchema: { ...z.toJSONSchema(squawkAskRequestSchema, { io: 'input' }), type: 'object' as const },
};

export const cancelWaitToolDefinition = {
  name: 'cezar_cancel_wait',
  description: 'Close a wait you opened with cezar_wait (PR, worker, request, peer, process or timer) or cezar_ask, by its wait_id, so it never wakes you. A question the user already sees cannot be cancelled; only their answer ends it. A wait that already resolved is delivered with your next wake anyway; the answer says so and lists the waits still open.',
  inputSchema: { ...z.toJSONSchema(squawkCancelWaitRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** hearsay-tools/cezarion#1234: the agent declares the task (or step) done; since
 *  hearsay-tools/cezarion#2397 it is the only way to. */
export const doneToolDefinition = {
  name: 'cezar_done',
  description: `Finish the task, or in a workflow step that is not the last, finish that step. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. Squawk closes the session at the end of this turn and cancels every open wait; after a step, Squawk starts the next step, and the answer names it. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, your question to the user is still pending, or input for you is still to be delivered (input_pending, listed in owed). A result or message that arrives after it is accepted is delivered with a note, and the task still finishes when that turn ends; a new message from the user, a new request or instruction, a failed result, or a wait or question you register withdraws it, so call cezar_done again when the task is complete.`,
  inputSchema: { ...z.toJSONSchema(squawkDoneRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** Tool definitions in registration order, evaluated only after boot seals. */
export function squawkToolDefinitions(env: NodeJS.ProcessEnv = process.env) {
  return enabledAgentTools(env).map(agentToolMetadata);
}
