import { callTool } from '../ci-wait/client.ts';
import { AUTOMATION_TOOL_CLIENT_TIMEOUT_MS } from '../core/github-request-limits.ts';
import { automationToolAnswerSchema, type AutomationToolAnswer } from '@open-mercato/cezar-contract/automation-tool';
import { SCHEDULED_TASK_LIMITS, scheduleTaskAnswerSchema, scheduledTasksAnswerSchema, type ScheduleTaskAnswer, type ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
const SCHEDULE_UNAVAILABLE = `Squawk could not reach its scheduler: the owning session is closed or the private IPC connection failed.`;
/**
 * hearsay-tools/cezarion#1465: unparsed too. A list of 50 schedules can pass the 32 KiB the
 * other answers fit in, so these two read up to the schedule answer cap.
 */
export function callScheduleTask(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ScheduleTaskAnswer> {
  return callTool(input, env, 'cezar_schedule_task', scheduleTaskAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes);
}

export function callScheduledTasks(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ScheduledTasksAnswer> {
  return callTool(input, env, 'cezar_scheduled_tasks', scheduledTasksAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes);
}

export function callAutomation(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<AutomationToolAnswer> {
  return callTool(input, env, 'cezar_automation', automationToolAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes, AUTOMATION_TOOL_CLIENT_TIMEOUT_MS);
}
