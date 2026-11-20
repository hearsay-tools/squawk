import { registerRunner } from '../core/runner-registry.ts';
import type { RunnerDefinition } from '../core/runner-definition.ts';
import { claudeRunner } from './claude/definition.ts';
import { codexRunner } from './codex/definition.ts';
import { opencodeRunner } from './opencode/definition.ts';
import { piRunner } from './pi/definition.ts';
import { ompRunner } from './omp/definition.ts';

/** The runners that ship with Squawk, in display order. A new built-in runner adds one line. */
export const BUILT_IN_RUNNERS: readonly RunnerDefinition[] = [claudeRunner, codexRunner, opencodeRunner, piRunner, ompRunner];

/** The ids of the built-in runners, in display order: what the closed runner tuple listed before
 *  runner ids opened (spec 2026-11-18-runner-definitions, decision 5). Tests and the lint rules enumerate it. */
export const BUILT_IN_RUNNER_IDS: readonly string[] = BUILT_IN_RUNNERS.map(({ id }) => id);

/**
 * Register every built-in runner. Each process entry calls it before it reads config or runs a
 * task. A second call registers the same objects again, which the registry ignores.
 */
export function registerBuiltInRunners(): void {
  for (const definition of BUILT_IN_RUNNERS) registerRunner(definition);
}
