import { z } from 'zod';

/**
 * The agent backends a run can be dispatched to. This module imports only zod: most contract
 * modules import the roster, and a schema module behind it would load in nearly every test
 * (hearsay-tools/cezarion#3241). `health.ts` re-exports both names.
 */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp']);
export type Runner = z.infer<typeof runnerSchema>;

/** How the cockpit names a runner Squawk no longer ships, on a run saved on it (hearsay-tools/squawk#3715). */
export function removedRunnerLabel(runner: string): string {
  return `${runner.charAt(0).toUpperCase()}${runner.slice(1)} (removed)`;
}

/** Why a run saved on a removed runner cannot resume its session, and what continues it instead. */
export function removedRunnerMessage(runner: string): string {
  const name = runner.charAt(0).toUpperCase() + runner.slice(1);
  return `The ${name} runner is no longer supported. Pick another runner to continue this task in a new session.`;
}
