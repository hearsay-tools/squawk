import { isRunnerId, type AgentBackend, type AgentRunner, type RunnerId } from './agent-runner.ts';
import type { RunnerDefinition } from './runner-definition.ts';

/**
 * The registered runners, in registration order (spec 2026-11-18-runner-definitions). An entry
 * registers the built-in runners with `registerBuiltInRunners()` (`runners/built-in.ts`) before
 * it reads config or runs a task; a test registers the definitions it uses. No core file imports
 * a runner file, so a test that drives one runner loads only that adapter
 * (hearsay-tools/cezarion#2939).
 */
const registry = new Map<RunnerId, RunnerDefinition>();

/** The runner that a task with no runner, a legacy id or an unknown id gets. */
export const DEFAULT_RUNNER_ID = 'claude' satisfies RunnerId;

/** Legacy ids that old records carry, each with the runner it now names. */
export const LEGACY_RUNNER_IDS: ReadonlyMap<string, RunnerId> = new Map([['claude-cli', 'claude']]);

/**
 * The runner a backend value names. A legacy id maps to its runner; undefined and an unknown value
 * map to the default runner (`claude`), as `createRunner` does.
 */
export function runnerIdOf(backend: string | undefined): RunnerId {
  if (backend === undefined) return DEFAULT_RUNNER_ID;
  return isRunnerId(backend) ? backend : LEGACY_RUNNER_IDS.get(backend) ?? DEFAULT_RUNNER_ID;
}

/**
 * Add one runner. Registering the same definition object again does nothing. A different
 * definition with an id that is already registered is an error, and so is a legacy id: the legacy
 * map resolves it for saved runs, so no runner may take it.
 */
export function registerRunner(definition: RunnerDefinition): void {
  if (LEGACY_RUNNER_IDS.has(definition.id)) {
    throw new Error(`Runner id ${definition.id} is a legacy id for ${LEGACY_RUNNER_IDS.get(definition.id)}; no runner may register it.`);
  }
  const registered = registry.get(definition.id);
  if (registered === definition) return;
  if (registered) throw new Error(`Runner ${definition.id} is already registered by another definition.`);
  registry.set(definition.id, definition);
}

function assertRegistered(): void {
  if (registry.size === 0) {
    throw new Error('No runner is registered: call registerBuiltInRunners() from runners/built-in.ts at the process entry, '
      + 'or register the runner definitions this test uses with registerRunner().');
  }
}

/** The registered runners, in registration order. */
export function registeredRunners(): RunnerDefinition[] {
  assertRegistered();
  return [...registry.values()];
}

/** Whether a runner with this id is registered. */
export function isRegisteredRunner(id: string): boolean {
  assertRegistered();
  return registry.has(id as RunnerId);
}

/** The registered definition of a runner. */
export function runnerDefinition(id: RunnerId): RunnerDefinition {
  assertRegistered();
  const definition = registry.get(id);
  if (!definition) throw new Error(`Runner ${id} is not registered: register its definition (runners/${id}/definition.ts) before you read it.`);
  return definition;
}

/**
 * The production `RunnerFactory`: it loads the registered definition's adapter. The entry points
 * pass it to `RunManager` and the planner; engine code takes a `RunnerFactory`. `claude-cli` is
 * the legacy id for `claude`. No id, and an id that no runner registered (an unknown string from
 * stored state), get the Claude runner.
 */
export async function createRunner(backend: AgentBackend | RunnerId | undefined): Promise<AgentRunner> {
  const id = backend === undefined ? DEFAULT_RUNNER_ID : LEGACY_RUNNER_IDS.get(backend) ?? backend;
  return runnerDefinition(isRegisteredRunner(id) ? id as RunnerId : DEFAULT_RUNNER_ID).loadAdapter();
}
