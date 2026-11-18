import { registerRunner } from '../core/runner-registry.ts';
import type { RunnerDefinition } from '../core/runner-definition.ts';
import { claudeRunner } from './claude/definition.ts';
import { codexRunner } from './codex/definition.ts';
import { opencodeRunner } from './opencode/definition.ts';
import { piRunner } from './pi/definition.ts';
import { ompRunner } from './omp/definition.ts';

/** The runners that ship with Squawk, in display order. A new built-in runner adds one line. */
export const BUILT_IN_RUNNERS: readonly RunnerDefinition[] = [claudeRunner, codexRunner, opencodeRunner, piRunner, ompRunner];

/**
 * Register every built-in runner. Each process entry calls it before it reads config or runs a
 * task. A second call registers the same objects again, which the registry ignores.
 */
export function registerBuiltInRunners(): void {
  for (const definition of BUILT_IN_RUNNERS) registerRunner(definition);
}
