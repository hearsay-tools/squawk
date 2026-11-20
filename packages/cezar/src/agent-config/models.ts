import { registeredRunners, runnerDefinition } from '../core/runner-registry.ts';
import type { AgentModelSettings } from '../core/runner-model-settings.ts';

/** The model defaults exposed by the coding agents' own settings files. */
export type AgentModelDefaults = Partial<Record<string, string>>;

/**
 * Each runner owns its native-settings policy: its definition's `models.loadSettings`. Vendor
 * precedence, environment variables, and provider composition stay inside that runner's module.
 */
export async function readAgentModelSettings(
  runner: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentModelSettings> {
  return (await runnerDefinition(runner).models.loadSettings()).read(repoRoot, env);
}

/** Read the current default model for each installed/configured coding agent. */
export async function readAgentModelDefaults(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentModelDefaults> {
  const entries = await Promise.all(
    registeredRunners().map(async ({ id }) => [
      id,
      (await readAgentModelSettings(id, repoRoot, env)).model,
    ] as const),
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
}

/** Read the provider that the agent itself will use for a bare model id. */
export async function readAgentModelProvider(
  runner: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return (await readAgentModelSettings(runner, repoRoot, env)).provider;
}
