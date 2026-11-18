import type { AgentRunner, RunnerId } from './agent-runner.ts';
import type { RunnerFacts } from './runner-facts.ts';

/**
 * Everything Squawk knows about one runner, in one object (spec 2026-11-18-runner-definitions).
 * Each runner's `runners/<id>/definition.ts` exports one, made with `defineRunner`, and an entry
 * registers it with `registerRunner` (`core/runner-registry.ts`). Plain data sits in the object;
 * the adapter loads on demand through `loadAdapter`. A definition module imports only types and
 * data, so importing it loads no adapter until `loadAdapter` runs. Later slices add parts.
 */
export interface RunnerDefinition {
  /** The runner id. */
  readonly id: RunnerId;
  /** What the runner's wire can do (`RunnerFacts`). */
  readonly facts: RunnerFacts;
  /** Imports the adapter module and builds a new runner. */
  loadAdapter(): Promise<AgentRunner>;
}

/** Declare one runner. */
export function defineRunner(definition: RunnerDefinition): RunnerDefinition {
  return definition;
}
