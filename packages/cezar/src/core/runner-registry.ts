import type { AgentRunner } from './agent-runner.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { DEFAULT_RUNNER_ID, LEGACY_RUNNER_IDS } from './runner-ids.ts';

/**
 * The registered runners, in registration order (spec 2026-11-18-runner-definitions). An entry
 * registers the built-in runners with `registerBuiltInRunners()` (`runners/built-in.ts`) before
 * it reads config or runs a task; a test registers the definitions it uses. No core file imports
 * a runner file, so a test that drives one runner loads only that adapter
 * (hearsay-tools/cezarion#2939).
 */
const registry = new Map<string, RunnerDefinition>();

/**
 * The runner a backend value names. A registered id resolves to its own runner (a non-built-in
 * one included), a legacy id to the runner it names, and undefined and an unknown value to the
 * default runner (`claude`), as `createRunner` does.
 */
export function resolveRunnerId(backend: string | undefined): string {
  if (backend === undefined) return DEFAULT_RUNNER_ID;
  const target = LEGACY_RUNNER_IDS.get(backend) ?? backend;
  return registry.has(target) ? target : DEFAULT_RUNNER_ID;
}

/** A runner id read back from saved data (a run, a workflow file), mapped as `resolveRunnerId`
 *  maps it, except that a process which registered no runner has no opinion: the saved id reads
 *  as written (planner decision 2026-11-20, option a). Undefined stays undefined. */
export function savedRunnerId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (LEGACY_RUNNER_IDS.has(id)) return LEGACY_RUNNER_IDS.get(id);
  return knownRunnerIds().length === 0 || registry.has(id) ? id : DEFAULT_RUNNER_ID;
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
  return registry.has(id);
}

/**
 * A runner id that its source has checked: a request that the route's runner check
 * (`server/runner-fields.ts`) admitted, or a saved setting. Throws when no runner registered it.
 */
export function registeredRunnerId(id: string): string {
  if (!isRegisteredRunner(id)) throw new Error(`Runner ${id} is not registered.`);
  return id;
}

/**
 * Whether a runner with this id is registered, or undefined when no runner is registered. Only the
 * read of saved runs uses it (`runs/legacy-run-rows.ts`): a process that registered no runner keeps
 * the read it had before runner ids were open. Every other read throws on an empty registry.
 */
export function savedRunnerRegistration(id: string): boolean | undefined {
  return registry.size === 0 ? undefined : registry.has(id);
}

/**
 * The runner ids this process knows: the registered ids, and nothing in a process that registered
 * no runner. Saved data (runs, workflow files, automation definitions) and the CLI's own checks of
 * a runner id read it. Never throws, like `savedRunnerRegistration`.
 */
export function knownRunnerIds(): readonly string[] {
  return [...registry.keys()];
}

/** The registered definition of a runner. */
export function runnerDefinition(id: string): RunnerDefinition {
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
export async function createRunner(backend: string | undefined): Promise<AgentRunner> {
  return runnerDefinition(resolveRunnerId(backend)).loadAdapter();
}
