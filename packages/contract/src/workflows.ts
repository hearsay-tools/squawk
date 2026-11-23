import { z } from 'zod';
import { runnerSchema, type Runner } from './runner.ts';

/**
 * The WORKFLOWS family: the chain catalog, the save/parse routes, and the planner.
 *
 * This file must NOT import `./runs.ts`: the run record embeds a workflow definition
 * (`RunRecord.workflowDef`), so `runs.ts` imports the two definition schemas below, and a second
 * edge back would be a module cycle — one whose top-level `z.object(…)` calls would hit a TDZ at
 * import time, not a type error.
 */

// ---- workflows (`GET/POST /workflows`, `DELETE /workflows/:name`, `POST /workflows/parse`) ----

/**
 * One step of a chain: an agent (`prompt`/`skill`), check (`command`), or plugin step.
 *
 * `onFail.max` carries a `.default(2)`, exactly as `src/workflows/types.ts` declares it, so the
 * OUTPUT shape the routes serve has `max` present whenever `onFail` is.
 */
export const workflowStepDefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().max(32).optional(),
    /** Authored agent-step wall-clock limit in ms. Omitted or 0 means no limit.
     *  Bound to Node's timer range so a larger value cannot become a 1ms kill. */
    timeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
    /** Per-step agent backend override (falls back to the task / config default). */
    runner: runnerSchema.optional(),
    /** Agent account id for this step (spec 2026-07-29-agent-profiles); resolved per step for owned workers (#452). */
    agentProfile: z.string().min(1).max(64).optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    kind: z.literal('plugin').optional(),
    pluginKind: z.string().min(1).max(64).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
      })
      .optional(),
  })
  .superRefine((s, ctx) => {
    const agent = Boolean(s.prompt ?? s.skill);
    const check = Boolean(s.command);
    const plugin = s.kind === 'plugin';
    if (Number(agent) + Number(check) + Number(plugin) !== 1) {
      ctx.addIssue({ code: 'custom', message: 'a step is either an agent step (prompt/skill), a check step (command), or a plugin step, not more than one' });
    }
    if (plugin && [s.prompt, s.skill, s.command].some(value => value !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'plugin steps cannot carry prompt, skill, or command' });
    }
    if (plugin && (s.pluginKind === 'agent' || s.pluginKind === 'check')) {
      ctx.addIssue({ code: 'custom', path: ['pluginKind'], message: 'pluginKind cannot name a built-in step kind' });
    }
    if (plugin && !s.pluginKind) {
      ctx.addIssue({ code: 'custom', path: ['pluginKind'], message: 'plugin steps require pluginKind' });
    }
    if (!plugin && (s.pluginKind !== undefined || s.config !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'pluginKind and config apply only to plugin steps' });
    }
    if (plugin) {
      for (const key of ['timeoutMs', 'model', 'effort', 'runner', 'agentProfile', 'allowedTools', 'bashAllowlist'] as const) {
        if (s[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} applies only to agent steps` });
      }
    } else if (check && s.timeoutMs !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['timeoutMs'], message: 'timeoutMs applies only to agent steps' });
    }
  });
export type WorkflowStepDef = z.infer<typeof workflowStepDefSchema>;

/** One catalog entry: the built-in `quick-task`, or a `.ai/cezar/workflows/*.yaml` file. */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  source: z.enum(['built-in', 'file']),
  /** Absent on built-ins — which is exactly what makes them undeletable. */
  path: z.string().optional(),
});
export type WorkflowDef = z.infer<typeof workflowDefSchema>;

/** Providers an original workflow executes, in the order of `runners` (the registered runners);
 *  command-only steps need no agent. */
export function providersRequiredByWorkflow(workflow: WorkflowDef, fallback: Runner, runners: readonly Runner[]): Runner[] {
  const required = new Set<Runner>();
  for (const step of workflow.steps) {
    if (!step.command && step.kind !== 'plugin') required.add(step.runner ?? fallback);
  }
  return runners.filter(provider => required.has(provider));
}


/** A workflow file that failed to load. Reported, never fatal — the catalog still answers. */
export const workflowLoadIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type WorkflowLoadIssue = z.infer<typeof workflowLoadIssueSchema>;

/** `GET /workflows` — the catalog plus the files that could not be read. */
export const workflowsResponseSchema = z.object({
  workflows: z.array(workflowDefSchema),
  issues: z.array(workflowLoadIssueSchema),
});
export type WorkflowsResponse = z.infer<typeof workflowsResponseSchema>;

/**
 * `POST /workflows` body: save a chain as `.ai/cezar/workflows/<slug>.yaml`.
 *
 * Exactly one of `steps` / the portable `skills` shorthand — the refinement below is the same
 * XOR the server enforces. Without `overwrite` an existing file answers 409 (`exists: true`).
 */
export const saveWorkflowInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });
export type SaveWorkflowInput = z.infer<typeof saveWorkflowInputSchema>;

/** `POST /workflows` — 201 with where the YAML landed. */
export const saveWorkflowResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type SaveWorkflowResponse = z.infer<typeof saveWorkflowResponseSchema>;

/** `POST /workflows/parse` (spec 012) — pasted YAML, normalized to plain steps. */
export const parsedWorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
});
export type ParsedWorkflow = z.infer<typeof parsedWorkflowSchema>;

/**
 * `DELETE /workflows/:name` — file workflows only; built-ins answer 400.
 *
 * `ok` is the LITERAL `true`, not a boolean: the only body carrying it is the success one, and
 * every failure is an `{ error }` status instead. The hand-written DTO said `boolean`, which
 * was wider than the route has ever been.
 */
export const deleteWorkflowResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
});
export type DeleteWorkflowResponse = z.infer<typeof deleteWorkflowResponseSchema>;

// ---- plan (`POST /plan`, spec 008) -------------------------------------------------------

/**
 * The proposed chain for a task. Never a hard failure: a missing CLI, a timeout or an
 * unparseable answer degrade to the one-step quick-task plan with `fallback: true`.
 */
export const planResponseSchema = z.object({
  /** The kebab-case workflow title the planner proposed. Absent on the degraded fallback. */
  name: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  rationale: z.string(),
  fallback: z.boolean(),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;
