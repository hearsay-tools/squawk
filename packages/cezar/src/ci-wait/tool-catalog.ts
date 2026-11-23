import { agentToolMetadata, enabledAgentTools } from './tool-registry.ts';
import { automationToolRequestSchema } from '@open-mercato/cezar-contract/automation-tool';
import { squawkAskRequestSchema, squawkCancelWaitRequestSchema, squawkDoneRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';
import { scheduleTaskRequestSchema, scheduledTasksRequestSchema } from '@open-mercato/cezar-contract/scheduled-tasks';
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

export const previewToolDefinition = {
  name: 'cezar_preview_serve',
  description: `Register a web dev server of this task so the user can click through it in the cockpit's live preview. Always pin the port (\`vite --strictPort\`, \`next dev -p\`) so the server comes up on the port you register. Squawk starts the command itself when the user opens the preview; do not wait for the user. ` +
    'To drive the browser the user sees, connect to `$CEZ_PREVIEW_CDP_URL` when it is set, e.g. `agent-browser --cdp "$CEZ_PREVIEW_CDP_URL" --pin-tab open http://localhost:5173`; the user watches your page live. `agent-browser record` needs ffmpeg on PATH.',
  inputSchema: { ...z.toJSONSchema(previewServeRequestSchema, { io: 'input' }), type: 'object' as const },
};

export const previewStopToolDefinition = {
  name: 'cezar_preview_stop',
  description: `Stop a preview server Squawk started for your own task. Set restart to true to reuse the unchanged command the owner approved, including after a crash. Adopted servers cannot be stopped; changed registrations need the owner to press Run and open again.`,
  inputSchema: { ...z.toJSONSchema(previewStopRequestSchema, { io: 'input' }), type: 'object' as const },
};

/**
 * hearsay-tools/cezarion#1465: a one-time schedule starts later as an ordinary task, so the agent
 * does not keep a session parked on timers for days. `cezar_scheduled_tasks` takes one action per
 * call; its union is advertised as one flat object for the same reason as `cezar_wait`.
 */
export const scheduleTaskToolDefinition = {
  name: 'cezar_schedule_task',
  description: `Schedule a new task to start once, later, in this project: give a name, the full prompt the task starts from, and either \`at\` (a UTC time YYYY-MM-DDTHH:MMZ, like every time in Squawk tools) or \`delay\` (30m, 6h, 7d of elapsed time from now). For a relative time ("in 2 hours"), use \`delay\`. For a clock time that the user names, convert it from the user's time zone to UTC. \`latest_start\` (10m to 30d) bounds how late it may still start after Squawk was down; past it the schedule is marked missed. Pass enable: true only when the user's request asks for the work to run later; otherwise it is created paused for the user to enable. The new task does not see this conversation, so put every detail it needs in the prompt. The answer gives \`due_at\` in UTC. The cockpit shows the schedule in local time.`,
  inputSchema: { ...z.toJSONSchema(scheduleTaskRequestSchema, { io: 'input' }), type: 'object' as const },
};

function flatScheduledTasksInputSchema() {
  const properties: Record<string, unknown> = {};
  for (const option of scheduledTasksRequestSchema.options) Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  return {
    type: 'object' as const,
    properties: {
      ...properties,
      action: { type: 'string', enum: scheduledTasksRequestSchema.options.map(option => option.shape.action.value), description: '"list" lists the one-time schedules of this project; "show", "update", "pause", "enable" and "cancel" take the `id` a list or a create answered.' },
      archived: { ...(properties.archived as object), description: 'action "list": "include" adds the archived schedules, "only" lists just them.' },
    },
    required: ['action'],
    additionalProperties: false,
  };
}
export const scheduledTasksToolDefinition = {
  name: 'cezar_scheduled_tasks',
  description: 'List, show, update, pause, enable or cancel the one-time scheduled tasks of this project, one action per call. Change only the schedules the user asked you to manage. "update" takes the same fields as cezar_schedule_task; a new `at` or `delay` must be in the future. "cancel" archives the schedule so it never starts; an archived schedule cannot change.',
  inputSchema: flatScheduledTasksInputSchema(),
};

function flatAutomationInputSchema() {
  const properties: Record<string, unknown> = {};
  for (const option of automationToolRequestSchema.options) Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  return { type: 'object' as const, properties: {
    ...properties,
    action: { type: 'string', enum: automationToolRequestSchema.options.map(option => option.shape.action.value) },
  }, required: ['action'], additionalProperties: false };
}
export const automationToolDefinition = {
  name: 'cezar_automation',
  description: 'Create, show, preview or enable a repeating automation in this project. "create" takes definition: a GitHub poll (kind github, events, intervalSeconds, filters and task) or repeating schedule (kind schedule, schedule and task). Creation is always paused. The Automations system instructions give the absolute CLI command: run its schema subcommand on demand for definition fields, bounds and prompt placeholders before creating. "show", "preview" and "enable" take its id. "preview" checks a GitHub poll without launching tasks. "enable" requires explicit: true, only when the user explicitly asked to switch it on; a poll also needs a successful preview of its current definition in this session. Autonomy is not enable consent. Report the url and preview matches, or next_run_at for a schedule (UTC; convert to the user’s zone). On refusal stop and report the error; never substitute a cron job, GitHub Action or polling script. Use cezar_schedule_task and cezar_scheduled_tasks for one-time schedules. Leave task.archiveWhenDone and task.autoMergePr off unless the user asks for each completion action.',
  inputSchema: flatAutomationInputSchema(),
};

/** Tool definitions in registration order, evaluated only after boot seals. */
export function squawkToolDefinitions(env: NodeJS.ProcessEnv = process.env) {
  return enabledAgentTools(env).map(agentToolMetadata);
}
