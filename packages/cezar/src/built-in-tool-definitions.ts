import { automationToolRequestSchema, automationToolAnswerSchema } from '@open-mercato/cezar-contract/automation-tool';
import { previewStopResult } from './preview/registration.ts';
import { askErrorMessage, askInvalidInput, ciErrorMessage, doneErrorMessage, doneInvalidInput, previewInvalidInput, previewOversized, previewRefusal, scheduleInvalidInput, scheduleRefusal, waitInvalidInput } from './ci-wait/errors.ts';
import { automationsToolEnabled, previewToolEnabled } from './ci-wait/tool-env.ts';
import { SCHEDULED_TASK_LIMITS, scheduleTaskAnswerSchema, scheduleTaskRequestSchema, scheduledTasksAnswerSchema, scheduledTasksRequestSchema } from '@open-mercato/cezar-contract/scheduled-tasks';

import { squawkAskAnswerSchema, squawkAskRequestSchema, squawkCancelWaitAnswerSchema, squawkCancelWaitRequestSchema, squawkDoneAnswerSchema, squawkDoneRequestSchema, squawkWaitAnswerSchema, squawkWaitRequestSchema } from '@open-mercato/cezar-contract/wait-tools';
import { ciWaitErrorCodeSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewStopRequestSchema, previewStopResultSchema, previewServeRequestSchema, previewServeResultSchema } from '@open-mercato/cezar-contract/preview';

import type { z } from 'zod';
import type { AgentToolDefinition } from './ci-wait/tool-registry.ts';
import type { SquawkToolHandlers } from './ci-wait/controller.ts';
import { WAIT_TOOL, ASK_TOOL, CANCEL_WAIT_TOOL, DONE_TOOL, PREVIEW_TOOL, PREVIEW_STOP_TOOL, SCHEDULE_TASK_TOOL, AUTOMATION_TOOL, SCHEDULED_TASKS_TOOL, formatWaitTool, formatAskTool, formatCancelWaitTool, formatDoneTool, formatPreviewTool, formatPreviewStopTool, formatScheduleTaskTool, formatAutomationTool, formatScheduledTasksTool, type SquawkTool } from './ci-wait/tools.ts';
import { AUTOMATION_TOOL_CLIENT_TIMEOUT_MS } from './core/github-request-limits.ts';

/** The controller validates once with this schema before dispatching the typed callback. */
function bind<S extends z.ZodType>(schema: S, handle: (handlers: SquawkToolHandlers, input: z.output<S>, signal: AbortSignal) => Promise<unknown>) {
  return { schema, handle: (handlers: SquawkToolHandlers, input: unknown, signal: AbortSignal) => handle(handlers, input as z.output<S>, signal) };
}
function metadata<S extends z.ZodType>(tool: SquawkTool, schema: S, format: (answer: z.output<S>) => import('./ci-wait/tool-registry.ts').AgentToolResult) {
  return { name: tool.definition.name, description: () => tool.definition.description, inputSchema: () => tool.definition.inputSchema, trigger: tool.trigger, label: tool.label, invoke: tool.invoke,
    format: (answer: unknown) => format(schema.parse(answer)) };
}
const invalid = (message: string) => ({ ok: false, code: 'invalid_request', message });
const unavailable = (message: string) => ({ ok: false, code: 'unavailable', message });
const ordinaryLimit = () => invalid('The arguments exceed 16 KiB.');
const thrownCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

export const coreAgentTools: AgentToolDefinition[] = [
  { ...metadata(WAIT_TOOL, squawkWaitAnswerSchema, formatWaitTool), ...bind(squawkWaitRequestSchema, async (h, input, signal) => squawkWaitAnswerSchema.parse((await h.registerWait(input, 'cezar_wait', signal)).answer)),
    maxBodyBytes: 16_384, committedReceipt: true,
    invalid: error => ({ ...invalid(waitInvalidInput(error)), effect: 'refused' }),
    oversized: () => ({ ...invalid('The arguments exceed 16 KiB. Nothing was created.'), effect: 'refused' }),
    unavailable: (error, input) => {
      const code = ciWaitErrorCodeSchema.safeParse(thrownCode(error));
      const operation_id = input && typeof input === 'object' && 'operation_id' in input ? input.operation_id : undefined;
      return code.success ? { ok: false, effect: 'refused', code: code.data, message: ciErrorMessage(code.data), operation_id }
        : { ok: false, effect: 'unknown', code: 'outcome_unknown', message: 'Registration outcome is unknown. Retry the same operation_id and arguments; do not add a fallback wait.', operation_id };
    } },
  { ...metadata(ASK_TOOL, squawkAskAnswerSchema, formatAskTool), ...bind(squawkAskRequestSchema, async (h, input, signal) => squawkAskAnswerSchema.parse(await h.ask(input, signal))),
    maxBodyBytes: 262_144, invalid: error => invalid(askInvalidInput(error)), oversized: () => invalid('The arguments exceed 256 KiB.'), unavailable: () => unavailable(askErrorMessage('unavailable')) },
  { ...metadata(CANCEL_WAIT_TOOL, squawkCancelWaitAnswerSchema, formatCancelWaitTool), ...bind(squawkCancelWaitRequestSchema, async (h, input, signal) => squawkCancelWaitAnswerSchema.parse(await h.cancelWait(input, signal))),
    maxBodyBytes: 16_384, invalid: error => ({ cancelled: false, code: 'invalid_request', message: waitInvalidInput(error) }),
    oversized: () => ({ cancelled: false, code: 'invalid_request', message: 'The arguments exceed 16 KiB.' }), unavailable: () => ({ cancelled: false, code: 'unavailable', message: ciErrorMessage('unavailable') }) },
  { ...metadata(DONE_TOOL, squawkDoneAnswerSchema, formatDoneTool), ...bind(squawkDoneRequestSchema, async (h, input, signal) => squawkDoneAnswerSchema.parse(await h.finishTurn(input, signal))),
    maxBodyBytes: 16_384, invalid: error => invalid(doneInvalidInput(error)), oversized: ordinaryLimit, unavailable: () => unavailable(doneErrorMessage('unavailable')) },
];
const schedulePolicy = {
  enabled: automationsToolEnabled, maxBodyBytes: SCHEDULED_TASK_LIMITS.wireBytes,
  invalid: (error: z.ZodError) => scheduleRefusal('invalid_request', scheduleInvalidInput(error)),
  oversized: () => scheduleRefusal('invalid_request', 'The arguments exceed 1 MiB.'),
  disabled: () => scheduleRefusal('automations_off'), unavailable: () => scheduleRefusal('unavailable'),
  envNames: () => ['CEZ_AUTOMATIONS'],
};
/** Temporary feature registrations; A2 moves these definitions into their owning features. */
export const featureAgentTools: AgentToolDefinition[] = [
  { ...metadata(PREVIEW_TOOL, previewServeResultSchema, formatPreviewTool), ...bind(previewServeRequestSchema, async (h, input, signal) => h.registerPreview ? previewServeResultSchema.parse(await h.registerPreview(input, signal)) : previewRefusal('headless')),
    enabled: previewToolEnabled, envNames: env => previewToolEnabled(env) ? ['CEZ_PREVIEW'] : [], maxBodyBytes: 16_384,
    invalid: previewInvalidInput, oversized: previewOversized, disabled: () => previewRefusal('preview_disabled'), unavailable: () => previewRefusal('unavailable') },
  { ...metadata(PREVIEW_STOP_TOOL, previewStopResultSchema, formatPreviewStopTool), ...bind(previewStopRequestSchema, async (h, input, signal) => h.stopPreview ? previewStopResultSchema.parse(await h.stopPreview(input, signal)) : previewStopResult('headless')),
    enabled: previewToolEnabled, maxBodyBytes: 16_384, invalid: () => previewStopResult('invalid_input'), oversized: () => previewStopResult('invalid_input'), disabled: () => previewStopResult('preview_disabled'), unavailable: () => previewStopResult('unavailable') },
  { ...metadata(SCHEDULE_TASK_TOOL, scheduleTaskAnswerSchema, formatScheduleTaskTool), ...schedulePolicy, ...bind(scheduleTaskRequestSchema, async (h, input, signal) => h.scheduleTask ? scheduleTaskAnswerSchema.parse(await h.scheduleTask(input, signal)) : scheduleRefusal('unavailable')) },
  { ...metadata(AUTOMATION_TOOL, automationToolAnswerSchema, formatAutomationTool), ...schedulePolicy, timeoutMs: AUTOMATION_TOOL_CLIENT_TIMEOUT_MS, runnerFields: { ids: ['definition.task.runner', 'definition.task.steps.*.runner'] },
    ...bind(automationToolRequestSchema, async (h, input, signal) => h.automation ? automationToolAnswerSchema.parse(await h.automation(input, signal)) : scheduleRefusal('unavailable')) },
  { ...metadata(SCHEDULED_TASKS_TOOL, scheduledTasksAnswerSchema, formatScheduledTasksTool), ...schedulePolicy, ...bind(scheduledTasksRequestSchema, async (h, input, signal) => h.scheduledTasks ? scheduledTasksAnswerSchema.parse(await h.scheduledTasks(input, signal)) : scheduleRefusal('unavailable')) },
];
