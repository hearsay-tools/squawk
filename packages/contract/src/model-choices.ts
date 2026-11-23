import { z } from 'zod';
import { effortLevelSchema } from './effort.ts';
import { runnerSchema } from './runner.ts';

/**
 * A runner whose model list is discovered from the host: every registered runner has a model
 * catalog (its definition's `loadModelCatalog`). The route's query validator and the picker use it.
 */
export const modelDiscoveryRunnerSchema = runnerSchema;
export type ModelDiscoveryRunner = z.infer<typeof modelDiscoveryRunnerSchema>;

export const runnerModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  effortLevels: z.array(effortLevelSchema).optional(),
});
export type RunnerModelOption = z.infer<typeof runnerModelOptionSchema>;

/** The models a spawn could pin instead of an unknown one, in a delegation error. It lives in its
 *  own leaf module so `delegation.ts` does not load `workspace.ts` (hearsay-tools/squawk#3935). */
export const modelChoicesSchema = z.object({
  runner: modelDiscoveryRunnerSchema,
  requestedModel: z.string(),
  availableModels: z.array(runnerModelOptionSchema),
  otherRunners: z.array(modelDiscoveryRunnerSchema),
});
export type ModelChoices = z.infer<typeof modelChoicesSchema>;
