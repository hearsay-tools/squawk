import { automationSessionHandlers } from './tool-session.ts';
import { productEnvEntries } from '../core/product-env.ts';
import { automationToolRequestSchema, automationToolAnswerSchema } from '@open-mercato/cezar-contract/automation-tool';
import { scheduleInvalidInput, scheduleRefusal } from './tool-errors.ts';
import { automationsToolEnabled } from './tool-env.ts';
import { SCHEDULED_TASK_LIMITS, scheduleTaskAnswerSchema, scheduleTaskRequestSchema, scheduledTasksAnswerSchema, scheduledTasksRequestSchema } from '@open-mercato/cezar-contract/scheduled-tasks';
import type { z } from 'zod';
import type { AgentToolDefinition } from '../ci-wait/tool-registry.ts';
import { SCHEDULE_TASK_TOOL, AUTOMATION_TOOL, SCHEDULED_TASKS_TOOL, formatScheduleTaskTool, formatAutomationTool, formatScheduledTasksTool } from './tools.ts';
import { AUTOMATION_TOOL_CLIENT_TIMEOUT_MS } from '../core/github-request-limits.ts';
import { bind, metadata } from '../ci-wait/tool-definition.ts';

const schedulePolicy = {
  sessionEnv: (env: NodeJS.ProcessEnv) => productEnvEntries('AUTOMATIONS', automationsToolEnabled(env) ? '1' : '0'),
  enabled: automationsToolEnabled, maxBodyBytes: SCHEDULED_TASK_LIMITS.wireBytes,
  invalid: (error: z.ZodError) => scheduleRefusal('invalid_request', scheduleInvalidInput(error)),
  oversized: () => scheduleRefusal('invalid_request', 'The arguments exceed 1 MiB.'),
  disabled: () => scheduleRefusal('automations_off'), unavailable: () => scheduleRefusal('unavailable'),
  envNames: () => ['CEZ_AUTOMATIONS'],
};
export const automationAgentTools: AgentToolDefinition[] = [
  { ...metadata(SCHEDULE_TASK_TOOL, scheduleTaskAnswerSchema, formatScheduleTaskTool), ...schedulePolicy, sessionHandlers: (_runId, host) => automationSessionHandlers(host), ...bind(scheduleTaskRequestSchema, async (h, input, signal) => h.scheduleTask ? scheduleTaskAnswerSchema.parse(await h.scheduleTask(input, signal)) : scheduleRefusal('unavailable')) },
  { ...metadata(AUTOMATION_TOOL, automationToolAnswerSchema, formatAutomationTool), ...schedulePolicy, timeoutMs: AUTOMATION_TOOL_CLIENT_TIMEOUT_MS, runnerFields: { ids: ['definition.task.runner', 'definition.task.steps.*.runner'] },
    ...bind(automationToolRequestSchema, async (h, input, signal) => h.automation ? automationToolAnswerSchema.parse(await h.automation(input, signal)) : scheduleRefusal('unavailable')) },
  { ...metadata(SCHEDULED_TASKS_TOOL, scheduledTasksAnswerSchema, formatScheduledTasksTool), ...schedulePolicy, ...bind(scheduledTasksRequestSchema, async (h, input, signal) => h.scheduledTasks ? scheduledTasksAnswerSchema.parse(await h.scheduledTasks(input, signal)) : scheduleRefusal('unavailable')) },
];
