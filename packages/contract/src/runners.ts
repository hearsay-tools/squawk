import { z } from 'zod';
import { runnerSchema } from './runner.ts';

/**
 * Which model ids a runner serves. `own`: its own provider's ids, so another runner's known preset
 * conflicts with it. `provider-spanning`: `provider/model` ids of every configured provider, so an
 * id it lists belongs to no runner alone.
 */
export const runnerModelIdScopeSchema = z.enum(['own', 'provider-spanning']);
export type RunnerModelIdScope = z.infer<typeof runnerModelIdScopeSchema>;

/** One registered runner as the cockpit shows it: the `display` part of its definition. */
export const runnerEntrySchema = z.object({
  id: runnerSchema,
  /** The runner's name on provider, account and conversation surfaces and in server messages. */
  displayName: z.string(),
  /** The runner's name in model discovery messages and in the model picker's status line. */
  modelListName: z.string(),
  modelIdScope: runnerModelIdScopeSchema,
});
export type RunnerEntry = z.infer<typeof runnerEntrySchema>;

/**
 * `GET /api/v1/runners`: the registered runners in display order (spec
 * 2026-11-18-runner-definitions, decision 2). The server reads its runner registry and never
 * probes a CLI; `GET /api/v1/health` still says which CLIs are installed.
 */
export const runnersResponseSchema = z.object({
  runners: z.array(runnerEntrySchema),
});
export type RunnersResponse = z.infer<typeof runnersResponseSchema>;
