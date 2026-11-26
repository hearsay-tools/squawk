/**
 * The launch parts that ship with Squawk (spec 2026-11-26-launch-slot-and-bundled-jobs § 2).
 * Each feature adds its system-prompt part, and artifacts its env, through the public launch
 * slot. Their orders keep the default system prompt byte for byte.
 */
import { artifactInstructions, provisionArtifactDirectory } from './artifacts/lifecycle.ts';
import { automationsEnabled } from './automations/enabled.ts';
import { automationCliCommand, automationsPrompt } from './automations/prompts.ts';
import { productEnvEntries } from './core/product-env.ts';
import { registerLaunchPart, sealLaunchParts, type LaunchPartDefinition } from './core/launch-registry.ts';
import { agentWebhooksPrompt, webhookCliCommand } from './webhooks/prompt.ts';
import { registryEntry } from './workspace/registry-entry.ts';
import { agentWebhooks } from './workspace/webhooks.ts';

/** Automations on AND a cockpit attached: the automations part of every session's system prompt. */
export const automationsLaunchPart: LaunchPartDefinition = {
  id: 'automations',
  order: 10,
  contribute: ({ cockpit }) => (cockpit && automationsEnabled() ? { prompt: automationsPrompt(automationCliCommand()) } : undefined),
};

/** The "Project webhooks" part (#1576): the webhooks this project exposes to agents, read from
 *  the registry when a session starts. Needs a cockpit to send through; nothing exposed, or an
 *  unreadable registry, adds nothing. */
export const webhooksLaunchPart: LaunchPartDefinition = {
  id: 'webhooks',
  order: 20,
  async contribute({ cockpit, repoRoot, home }) {
    if (!cockpit) return undefined;
    const entry = await registryEntry(cockpit.projectId, repoRoot, home).catch(() => undefined);
    return { prompt: agentWebhooksPrompt(webhookCliCommand(), agentWebhooks(entry)) };
  },
};

/** The run's artifact directory as env, and the artifact contract. */
export const artifactsLaunchPart: LaunchPartDefinition = {
  id: 'artifacts',
  order: 30,
  contribute({ dataDir, runId }) {
    const directory = provisionArtifactDirectory(dataDir, runId);
    return { env: productEnvEntries('ARTIFACTS_DIR', directory), prompt: artifactInstructions(directory) };
  },
};

export const BUILT_IN_LAUNCH_PARTS: readonly LaunchPartDefinition[] = [
  automationsLaunchPart, webhooksLaunchPart, artifactsLaunchPart,
];

/** Register the built-in launch parts. A second call registers the same objects, which the registry ignores. */
export function registerBuiltInLaunchParts(): void {
  for (const part of BUILT_IN_LAUNCH_PARTS) registerLaunchPart(part);
}

/** Seal after every built-in and extension registration at the boot boundary. */
export function sealBuiltInLaunchParts(): void {
  sealLaunchParts();
}
