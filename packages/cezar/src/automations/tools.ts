import type { SquawkTool } from '../ci-wait/tools.ts';
import type { ScheduleTaskAnswer, ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { scheduleTaskToolDefinition, automationToolDefinition, scheduledTasksToolDefinition } from './tool-catalog.ts';
import { callScheduleTask, callScheduledTasks, callAutomation } from './tool-client.ts';
function scheduleHint(answer: ScheduleTaskAnswer | ScheduledTasksAnswer): string {
  if (answer.ok) return 'Done. due_at is UTC: tell the user that time in their time zone, and name the zone.';
  return answer.code === 'automations_off' || answer.code === 'unavailable' ? 'Not scheduled. Tell the user, and do not retry.' : 'Not changed. Fix the call from the message, or continue without it.';
}
export async function invokeScheduleTaskTool(input: unknown) {
  return formatScheduleTaskTool(await callScheduleTask(input));
}
export function formatScheduleTaskTool(answer: Awaited<ReturnType<typeof callScheduleTask>>) {
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${scheduleHint(answer)}` }], isError: !answer.ok, details: answer };
}
export async function invokeScheduledTasksTool(input: unknown) {
  return formatScheduledTasksTool(await callScheduledTasks(input));
}
export function formatScheduledTasksTool(answer: Awaited<ReturnType<typeof callScheduledTasks>>) {
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${scheduleHint(answer)}` }], isError: !answer.ok, details: answer };
}
export async function invokeAutomationTool(input: unknown) {
  return formatAutomationTool(await callAutomation(input));
}
export function formatAutomationTool(answer: Awaited<ReturnType<typeof callAutomation>>) {
  const hint = answer.ok ? 'Report the url and preview matches, or the next occurrence in the user’s time zone.' : 'Stop and report the error. Do not substitute another automation mechanism.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
}
export const AUTOMATION_TOOL: SquawkTool = { definition: automationToolDefinition, trigger: 'load when the user asks for recurring work, or wants to inspect or activate an automation.', label: 'Automations', invoke: invokeAutomationTool };
export const SCHEDULE_TASK_TOOL: SquawkTool = { definition: scheduleTaskToolDefinition, trigger: 'load when work should start later as a new task (in an hour, tomorrow, next week) instead of keeping this session waiting.', label: 'Schedule a task', invoke: invokeScheduleTaskTool };
export const SCHEDULED_TASKS_TOOL: SquawkTool = { definition: scheduledTasksToolDefinition, trigger: 'load when you need to list, change, pause, resume or cancel a one-time scheduled task.', label: 'Scheduled tasks', invoke: invokeScheduledTasksTool };
