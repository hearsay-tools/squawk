import { z } from 'zod';
import { automationToolRequestSchema } from '@open-mercato/cezar-contract/automation-tool';
import { scheduleTaskRequestSchema, scheduledTasksRequestSchema } from '@open-mercato/cezar-contract/scheduled-tasks';

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
