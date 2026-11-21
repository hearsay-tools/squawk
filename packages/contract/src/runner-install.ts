import { z } from 'zod';
import { runnerSchema } from './runner.ts';

export const runnerInstallParamsSchema = z.object({ runner: runnerSchema });
export const runnerInstallActionSchema = z.object({ action: z.enum(['check', 'install', 'update', 'remove']) });
export const runnerInstallPhaseSchema = z.enum(['idle', 'checking', 'downloading', 'verifying', 'extracting', 'activating', 'removing', 'failed']);
export const runnerInstallStatusSchema = z.object({
  supported: z.boolean(),
  installedVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  phase: runnerInstallPhaseSchema,
  error: z.string().nullable(),
});
export type RunnerInstallStatus = z.infer<typeof runnerInstallStatusSchema>;
export type RunnerInstallAction = z.infer<typeof runnerInstallActionSchema>['action'];
