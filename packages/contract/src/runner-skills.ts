import { z } from 'zod';
import { runnerSchema } from './health.ts';

export const runnerSkillScopeSchema = z.enum(['repo', 'user', 'system', 'other']);
export const runnerSkillsQuerySchema = z.object({
  runner: runnerSchema,
  account: z.string().min(1).max(64).optional(),
  refresh: z.literal('1').optional(),
});
export const runnerSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  scope: runnerSkillScopeSchema.optional(),
  plugin: z.string().optional(),
  path: z.string().optional(),
});
export const runnerSkillProblemSchema = z.object({ message: z.string(), path: z.string().optional() });
export const runnerSkillListSchema = z.object({
  runner: runnerSchema,
  skills: z.array(runnerSkillSchema),
  problems: z.array(runnerSkillProblemSchema),
  source: z.enum(['live', 'cache', 'unavailable']),
  reason: z.string().optional(),
});
export type RunnerSkill = z.infer<typeof runnerSkillSchema>;
export type RunnerSkillScope = z.infer<typeof runnerSkillScopeSchema>;
export type RunnerSkillProblem = z.infer<typeof runnerSkillProblemSchema>;
export type RunnerSkillList = z.infer<typeof runnerSkillListSchema>;
