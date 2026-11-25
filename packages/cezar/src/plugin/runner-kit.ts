/**
 * Lightweight definition-time runner kit re-exported by `@hearsay-tools/squawk/plugin`
 * (spec 2026-11-24-plugin-loader-and-runner-kit, § 3). Holds all runner kit types plus the pure
 * metadata/env values that runner `definition.ts` and data modules read at boot. Heavy runtime
 * helpers live under `@hearsay-tools/squawk/plugin/{runtime,model-settings,managed-cli,pi-rpc}` so
 * `bootRuntime()` never eagerly loads `node:child_process`, TOML/YAML parsers, managed-CLI
 * storage, or Pi RPC code.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

// Runner definition and adapter contract.
export { z } from 'zod';
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
export { SQUAWK_SIDE_SPEC_SUPPORT } from '../core/agent-runner-values.ts';
export type { EffortLevel } from '@open-mercato/cezar-contract/effort';
export type { RunnerAgentConfig } from '@open-mercato/cezar-contract/runners';

// Environment and paths needed by definitions and metadata.
export { MULTI_PROVIDER_PREFIXES } from '../core/agent-env.ts';
export { productEnv } from '../core/product-env.ts';
export { agentHomeDir, agentUserHome } from '../paths.ts';
export type { LeaderState } from '../core/session-process.ts';
export type { RunnerTimings } from '../core/runner-runtime.ts';
export type { SpawnScope } from '../worker-scope/scope.ts';

// Cockpit events, hooks, skills, models, config files, and managed-CLI types.
export type {
  FileDiff, HookEntryKind, HookStatus, PermissionOption, PlanEntry, PlanStatus, SkillInputIdentity, StopReason, TokenUsage,
  ToolLocation, ToolStatus, UiAskQuestion, UiAskRequestedEvent, UiEvent, UiHookItem, UiItem, UiMessageItem, UiPermissionRequestedEvent,
  UiReasoningItem, UiSessionStartedEvent, UiToolItem, UiTurnCompletedEvent, UiUsageUpdatedEvent,
} from '../core/ui-events.ts';
export type { AskQuestion } from '../core/ask.ts';
export type { RawUsage } from '../core/usage.ts';
export type { SkillDiscoveryOptions } from '../core/skill-probe.ts';
export type { SkillCatalog } from '../core/runner-skill-catalog.ts';
export type { ModelDiscoveryContext, ModelOption } from '../core/runner-model-catalog.ts';
export type { ModelDiscoveryOptions } from '../core/model-discovery-options.ts';
export type { ModelProbeSpawnImpl } from '../core/model-probe-spawn.ts';
export type { AgentModelSettingsStrategy } from '../core/runner-model-settings.ts';
export type { NativeSettingsFile } from '../agent-config/model-settings/shared.ts';
export { agentHome } from '../core/runner-config-files.ts';
export type { AgentHomePaths, RunnerConfigFile } from '../core/runner-config-files.ts';
export { PROJECT_AGENTS_FILE } from '../core/project-agents-file.ts';
export { EDITOR_PLUS_COMMIT_NOTE } from '../core/agent-config-notes.ts';
export type { ProviderCommandResult, ProviderConnectionState } from '../core/provider-auth.ts';
export type { ManagedCliManifest } from '../core/managed-cli-source.ts';
export type { PiEndWatchdog, PiSkillSubmission, PiTurnMessages } from '../core/pi-rpc-turn.ts';

// Mock scenarios for the runner's parity mock.
export {
  COMMON_MOCK_SCENARIOS, MOCK_BASELINE_PROMPT, NATIVE_APPROVAL_MOCK_SCENARIOS, PROVIDER_ERROR_MOCK_SCENARIOS,
  STDIO_ASK_MOCK_SCENARIOS,
} from '../core/mock-prompts.ts';
