/**
 * The runner kit: every core value and type that a runner folder reads from outside itself
 * (spec 2026-11-24-plugin-loader-and-runner-kit, § 3). A runner imports these names from
 * `@hearsay-tools/squawk/plugin`, never by a relative path out of `runners/<id>/`
 * (`cez/runner-core-import`). This module only re-exports: it holds no state of its own, so a
 * plugin and the host share the one copy of each stateful module it names.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

// Runner definition and adapter contract.
export { defineRunner } from '../core/runner-definition.ts';
export type {
  RunnerAccountsData, RunnerBrowserSignIn, RunnerCli, RunnerConfigFiles, RunnerDetection, RunnerDisplay, RunnerEnv,
  RunnerLoginData, RunnerLoginStatus, RunnerMock, RunnerModelData,
} from '../core/runner-definition.ts';
export type { RunnerFacts } from '../core/runner-facts.ts';
export type {
  AgentEvent, AgentRunResult, AgentRunSpec, AgentRunSpecSupport, AgentRunner, AgentSession, AgentToolCallRecord,
  ContentBlock, InputDelivery, SessionOptions, ToolGrant,
} from '../core/agent-runner.ts';
export {
  SQUAWK_SIDE_SPEC_SUPPORT, SessionEndedBeforeAcknowledgement, isAbortError, isSignalTerminationExit, prependSystemPrompt,
  trackChildExit, unknownToolGrant,
} from '../core/agent-runner-values.ts';
export { codexToolGrantFields, ompRequestedTools, opencodeToolGrantFields } from '../core/runner-tool-grants.ts';

// Child processes, sessions and their environment.
export { MULTI_PROVIDER_PREFIXES, buildChildEnv } from '../core/agent-env.ts';
export { profileEnv } from '../core/agent-profiles.ts';
export { productEnv } from '../core/product-env.ts';
export { shellQuote } from '../core/shell-env.ts';
export { agentHomeDir, agentUserHome } from '../paths.ts';
export { probeLeaderState, signalSession, spawnSessionLeader, waitForEofExit } from '../core/session-process.ts';
export type { LeaderState } from '../core/session-process.ts';
export { SessionDescendants } from '../core/session-descendants.ts';
export {
  AUTO_END_DELAY_MS, DEFAULT_RUNNER_TIMINGS, afterExitDrain, boundOutputDrainAfterExit, exitDrainBudget,
} from '../core/runner-runtime.ts';
export type { RunnerTimings } from '../core/runner-runtime.ts';
export { summarizeRunnerStderr } from '../core/runner-stderr.ts';
export { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
export { readNdjson } from '../core/ndjson.ts';
export { InputSubmissions } from '../core/input-submissions.ts';
export { V1TextCoalescer } from '../core/v1-text-coalescer.ts';
export { ownLookup } from '../core/own-lookup.ts';
export type { SpawnScope } from '../worker-scope/scope.ts';

// Cockpit events and hooks.
export type {
  FileDiff, HookEntryKind, HookStatus, PermissionOption, PlanEntry, PlanStatus, SkillInputIdentity, StopReason, TokenUsage,
  ToolLocation, ToolStatus, UiAskQuestion, UiAskRequestedEvent, UiEvent, UiHookItem, UiItem, UiMessageItem, UiPermissionRequestedEvent,
  UiReasoningItem, UiSessionStartedEvent, UiToolItem, UiTurnCompletedEvent, UiUsageUpdatedEvent,
} from '../core/ui-events.ts';
export { hookEventName, isVisibleHookItem } from '../core/hook-items.ts';
export { parseAskRequest, uiAskQuestions } from '../core/ask.ts';
export type { AskQuestion } from '../core/ask.ts';
export { editWriteKey } from '../core/edit-write-key.ts';
export { costWeightedTokens } from '../core/usage.ts';
export type { RawUsage } from '../core/usage.ts';
export { squawkToolEnvNames, squawkToolNames } from '../ci-wait/tool-names.ts';

// Skills.
export { claudeSkillContent, openingContent, openingInput, skillOf, slashSkillPrompt, validSkillMessage } from '../core/skill-trigger.ts';
export { skillLines, skillOutput, skillProbe } from '../core/skill-probe.ts';
export type { SkillDiscoveryOptions } from '../core/skill-probe.ts';
export { skillPathPlugin, skillPathScope } from '../core/skill-path-scope.ts';
export type { SkillCatalog } from '../core/runner-skill-catalog.ts';

// Models.
export type { ModelDiscoveryContext, ModelOption } from '../core/runner-model-catalog.ts';
export type { ModelDiscoveryOptions } from '../core/model-discovery-options.ts';
export { formatModelIdentity, parseModelIdentity } from '../core/model-identity.ts';
export { spawnModelProbe } from '../core/model-probe-spawn.ts';
export type { ModelProbeSpawnImpl } from '../core/model-probe-spawn.ts';
export { modelProbeTeardown } from '../core/model-probe-teardown.ts';
export type { AgentModelSettingsStrategy } from '../core/runner-model-settings.ts';
export {
  configuredString, firstConfiguredModel, firstConfiguredProvider, parseConfigContent, readNativeSettingsFiles,
} from '../agent-config/model-settings/shared.ts';
export type { NativeSettingsFile } from '../agent-config/model-settings/shared.ts';

// Native config files, sign-in and accounts.
export { agentHome } from '../core/runner-config-files.ts';
export type { AgentHomePaths, RunnerConfigFile } from '../core/runner-config-files.ts';
export { PROJECT_AGENTS_FILE } from '../core/project-agents-file.ts';
export { EDITOR_PLUS_COMMIT_NOTE } from '../core/agent-config-notes.ts';
export { normalizedLines } from '../core/login-output.ts';
export type { ProviderCommandResult, ProviderConnectionState } from '../core/provider-auth.ts';
export { BrowserSignInStartError, redactBrowserSignInDetails } from '../core/browser-sign-in-error.ts';

// Managed CLI installs.
export type { ManagedCliManifest } from '../core/managed-cli-source.ts';
export { leaseManagedCli, managedCliExecutable } from '../managed-install/cli-storage.ts';
export { managedCliHome } from '../managed-install/runtime-home.ts';

// Mock scenarios for the runner's parity mock.
export {
  COMMON_MOCK_SCENARIOS, MOCK_BASELINE_PROMPT, NATIVE_APPROVAL_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS,
  STDIO_ASK_MOCK_SCENARIOS,
} from '../core/mock-prompts.ts';

// The Pi-family RPC wire (pi, omp) and its JSON field readers.
export {
  contentText, isRecord, number, ompRpcError, ompSkillPrompt, parseRpcLine, piRpcError, string, toPiPrompt, truncate,
  waitForExit,
} from '../core/pi-rpc-wire.ts';
export {
  PiRpcInput, PiTextBlocks, adoptRpcSessionId, armEndWatchdog, dispatchPiTurnMessage, settlePiFamilyExit,
} from '../core/pi-rpc-turn.ts';
export type { PiEndWatchdog, PiSkillSubmission, PiTurnMessages } from '../core/pi-rpc-turn.ts';
