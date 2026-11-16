import { z } from 'zod';
import { automationCreateSchema } from './automation-requests.ts';
import { storedAutomationDefinitionSchema } from './automation-storage.ts';
import { scheduledTaskRefusalCodeSchema } from './scheduled-tasks.ts';

/** Repeating automations only. Creation never accepts an enable flag. */
export const repeatingAutomationInputSchema = automationCreateSchema.omit({ enabled: true, enable: true })
  .refine(value => value.schedule?.type !== 'once', 'Use cezar_schedule_task for a one-time schedule.');
const id = z.string().min(1).max(100);
export const automationToolRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), definition: repeatingAutomationInputSchema }).strict(),
  z.object({ action: z.literal('show'), id }).strict(),
  z.object({ action: z.literal('preview'), id }).strict(),
  z.object({ action: z.literal('enable'), id, explicit: z.boolean().optional() }).strict(),
]);
export type AutomationToolRequest = z.infer<typeof automationToolRequestSchema>;
export const automationToolAnswerSchema = z.union([
  z.object({
    ok: z.literal(true), automation: storedAutomationDefinitionSchema,
    url: z.string().optional(), next_run_at: z.string().optional(),
    preview: z.object({ matches: z.number().int().nonnegative(), truncated: z.boolean() }).optional(),
  }),
  z.object({ ok: z.literal(false), code: z.enum([...scheduledTaskRefusalCodeSchema.options, 'explicit_required', 'preview_required']), message: z.string() }),
]);
export type AutomationToolAnswer = z.infer<typeof automationToolAnswerSchema>;
