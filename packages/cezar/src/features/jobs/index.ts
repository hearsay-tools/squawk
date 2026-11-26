/**
 * The bundled jobs feature (spec 2026-11-26-launch-slot-and-bundled-jobs): `hsq job`, the deletion
 * gate that keeps a task's scratch while a job runs in it, and the launch prompt's "Long commands"
 * part. It registers through the plugin API only; nothing outside this folder imports it.
 */
import type { CliCommandDefinition, LaunchPartDefinition, SquawkPluginApi } from '../../plugin/index.ts';
import { jobInstructions } from './command.ts';
import { jobsDeletionGate } from './removal-slot.ts';

/** `hsq job`: it parses its own argv and needs no runtime. */
export const jobCliCommand: CliCommandDefinition = {
  name: 'job', usage: ["  cez job start <name> -- <cmd> run a long command that outlives the agent session (see: job --help)"],
  parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none',
  load: async () => (await import('./cli.ts')).runJobCommand,
};

/** The "Long commands" part of every launch prompt, after the artifact contract. */
export const jobsLaunchPart: LaunchPartDefinition = {
  id: 'jobs',
  order: 40,
  contribute: () => ({ prompt: jobInstructions() }),
};

export default function setup(api: SquawkPluginApi): void {
  api.registerCliCommand(jobCliCommand);
  api.registerRemovalSlots({ gates: [jobsDeletionGate] });
  api.registerLaunchPart(jobsLaunchPart);
}
