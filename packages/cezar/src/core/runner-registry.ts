import { createKeyedRegistry } from './registry.ts';
import type { AgentRunner } from './agent-runner.ts';
import type { RunnerDefinition } from './runner-definition.ts';
import { DEFAULT_RUNNER_ID, LEGACY_RUNNER_IDS } from './runner-ids.ts';

/** Register definitions first; the process entry seals before normal reads. */
const runners = createKeyedRegistry<string, RunnerDefinition>({
  name: 'Runner registry',
  bootHint: 'call registerBuiltInRunners() then sealBuiltInRunners() at the process entry, or sealTestRunners() in a test.',
  reservedKeys: [...LEGACY_RUNNER_IDS.keys()],
});

/** Finish registration at the process boot boundary. */
export function sealRunners(): void { runners.seal(); }

/** Whether normal runner reads are available. */
export function runnersSealed(): boolean { return runners.isSealed(); }

/**
 * The runner a backend value names. A registered id resolves to its own runner (a non-built-in
 * one included), a legacy id to the runner it names, and undefined and an unknown value to the
 * default runner (`claude`), as `createRunner` does.
 */
export function resolveRunnerId(backend: string | undefined): string {
  const target = backend === undefined ? DEFAULT_RUNNER_ID : LEGACY_RUNNER_IDS.get(backend) ?? backend;
  return runners.has(target) ? target : DEFAULT_RUNNER_ID;
}

/** A runner id read back from saved data (a run, a workflow file), mapped as `resolveRunnerId`
 *  maps it, except that a process whose runner registry is unsealed has no opinion: the saved id reads
 *  as written (planner decision 2026-11-20, option a). Undefined stays undefined. */
export function savedRunnerId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (LEGACY_RUNNER_IDS.has(id)) return LEGACY_RUNNER_IDS.get(id);
  return !runners.isSealed() || runners.has(id) ? id : DEFAULT_RUNNER_ID;
}

/**
 * Add one runner. Registering the same definition object again does nothing. A different
 * definition with an id that is already registered is an error, and so is a legacy id: the legacy
 * map resolves it for saved runs, so no runner may take it.
 */
export function registerRunner(definition: RunnerDefinition): void {
  runners.register(definition.id, definition);
}

/** The registered runners, in registration order. */
export function registeredRunners(): RunnerDefinition[] {
  return runners.values();
}

/** Whether a runner with this id is registered. */
export function isRegisteredRunner(id: string): boolean {
  return runners.has(id);
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
 * Whether a runner with this id is registered, or undefined while the registry is unsealed. Only the
 * read of saved runs uses it (`runs/legacy-run-rows.ts`): an unsealed process keeps
 * the read it had before runner ids were open. Every other read throws on an unsealed registry.
 */
export function savedRunnerRegistration(id: string): boolean | undefined {
  return !runners.isSealed() ? undefined : runners.has(id);
}

/**
 * The runner ids this process knows: the registered ids after seal, and nothing before seal.
 * Saved data (runs, workflow files, automation definitions) and the CLI's own runner-id checks
 * read it. Never throws, like `savedRunnerRegistration`.
 */
export function knownRunnerIds(): readonly string[] {
  return runners.isSealed() ? runners.keys() : [];
}

/** The registered definition of a runner. */
export function runnerDefinition(id: string): RunnerDefinition {
  const definition = runners.get(id);
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
