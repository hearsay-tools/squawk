import { z } from 'zod';
import { conversationCapacitySchema } from './conversations.ts';
import { runStatusSchema } from './run-status.ts';
import { runnerSchema } from './runner.ts';
import { modelDiscoveryRunnerSchema } from './model-choices.ts';
import { providerStatusSchema, runnerModelCatalogResponseSchema } from './workspace.ts';

/** Host default-account discovery; delegation credentials select the controller, not an account. */
export const hostDiscoveryRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runners') }).strict(),
  z.object({ kind: z.literal('models'), runner: modelDiscoveryRunnerSchema }).strict(),
]);
export const discoveryRequestSchema = z.discriminatedUnion('kind', [
  ...hostDiscoveryRequestSchema.options,
  z.object({ kind: z.literal('tasks'), all: z.boolean().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
]);
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export const discoveredRunnerSchema = providerStatusSchema.omit({ provider: true, profileId: true }).extend({ runner: modelDiscoveryRunnerSchema });
export const discoveredRunnersSchema = z.object({
  scope: z.literal('host-default-account'),
  runners: z.array(discoveredRunnerSchema),
});
export type DiscoveredRunners = z.infer<typeof discoveredRunnersSchema>;
export const discoveredTasksSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(), title: z.string(), runner: runnerSchema.optional(),
    status: runStatusSchema,
    attention: z.enum(['permission', 'error', 'waiting', 'running', 'unseen', 'none']),
    attentionLabel: z.string(), accepts: z.boolean(), reason: z.string().optional(),
  })).max(32),
  nextOffset: z.number().int().nonnegative().optional(),
  /** The caller's own family ledger load; no recipient inbox. */
  capacity: conversationCapacitySchema.optional(),
});
export type DiscoveredTasks = z.infer<typeof discoveredTasksSchema>;
export const discoveryResponseSchema = z.union([discoveredRunnersSchema, runnerModelCatalogResponseSchema, discoveredTasksSchema]);
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
