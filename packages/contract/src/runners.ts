import { z } from 'zod';
import { runnerSchema } from './runner.ts';

/**
 * Which model ids a runner serves. `own`: its own provider's ids, so another runner's known preset
 * conflicts with it. `provider-spanning`: `provider/model` ids of every configured provider, so an
 * id it lists belongs to no runner alone.
 */
export const runnerModelIdScopeSchema = z.enum(['own', 'provider-spanning']);
export type RunnerModelIdScope = z.infer<typeof runnerModelIdScopeSchema>;

/** One model the picker suggests before host discovery answers. `id: ''` is auto. */
export const runnerModelPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  desc: z.string(),
});
export type RunnerModelPreset = z.infer<typeof runnerModelPresetSchema>;

/** The model data the cockpit reads: the picker's suggestions and the ids a runner retired. */
export const runnerModelSuggestionsSchema = z.object({
  /** The picker's fallback suggestions, in order; the first is auto. */
  suggested: z.array(runnerModelPresetSchema),
  /** Retired model ids. They are no presets any more, but another runner still refuses them. */
  retired: z.array(z.string()),
});
export type RunnerModelSuggestions = z.infer<typeof runnerModelSuggestionsSchema>;

/** One group of the Settings → Agent config pane. The file filter stays in the cockpit. */
export const runnerAgentConfigGroupSchema = z.object({
  id: z.enum(['settings', 'mcp', 'memory']),
  label: z.string(),
  /** Group-level caveat, for example where this agent keeps its MCP servers. */
  note: z.string().optional(),
  /** Shown instead of the file list when the group has nothing to list. */
  empty: z.string().optional(),
  /** The group also shows the user-level MCP listing, even with no file. */
  showsUserMcp: z.literal(true).optional(),
});
export type RunnerAgentConfigGroup = z.infer<typeof runnerAgentConfigGroupSchema>;

/** The Settings → Agent config pane of one runner. */
export const runnerAgentConfigSchema = z.object({
  /** The agent's name on its tab. */
  label: z.string(),
  /** Pane-level caveat shown under the agent's heading. */
  note: z.string().optional(),
  groups: z.array(runnerAgentConfigGroupSchema),
});
export type RunnerAgentConfig = z.infer<typeof runnerAgentConfigSchema>;

/** One registered runner as the cockpit shows it: the parts of its definition the cockpit reads. */
export const runnerEntrySchema = z.object({
  id: runnerSchema,
  /** The runner's name on provider, account and conversation surfaces and in server messages. */
  displayName: z.string(),
  /** The runner's name in model discovery messages and in the model picker's status line. */
  modelListName: z.string(),
  modelIdScope: runnerModelIdScopeSchema,
  /** The runner's name in the runner picker. */
  pickerLabel: z.string(),
  /** The runner's line in the runner picker. */
  pickerDescription: z.string(),
  /** A key for the cockpit's icon set. An unknown key shows the generic runner icon. */
  icon: z.string(),
  /** What the accounts pane says when the CLI is not installed. */
  installHint: z.string(),
  /** The command that logs the CLI in, as a terminal runs it. */
  loginCommand: z.string(),
  /** false when this runner has no terminal sign-in command. Omitted means available. */
  terminalLogin: z.boolean().optional(),
  /** The runner can sign in through an ephemeral browser flow in the cockpit. */
  browserLogin: z.boolean().optional(),
  /** The cockpit can install, update and remove this runner's managed CLI. */
  managedInstall: z.literal(true).optional(),
  /** A generic example account folder for the add-account dialog. */
  accountFolderExample: z.string().optional(),
  models: runnerModelSuggestionsSchema,
  agentConfig: runnerAgentConfigSchema,
});
export type RunnerEntry = z.infer<typeof runnerEntrySchema>;

/**
 * `GET /api/v1/runners`: the registered runners in display order (spec
 * 2026-11-18-runner-definitions, decision 2). The server reads its runner registry and never
 * probes a CLI; `GET /api/v1/health` still says which CLIs are installed.
 */
export const runnersResponseSchema = z.object({
  runners: z.array(runnerEntrySchema),
});
export type RunnersResponse = z.infer<typeof runnersResponseSchema>;
