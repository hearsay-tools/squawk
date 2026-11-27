/**
 * The public plugin entry, `@hearsay-tools/squawk/plugin` (spec 2026-11-24-plugin-loader-and-runner-kit).
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */
export type { SquawkPlugin, SquawkPluginApi } from './api.ts';
export type { RunnerDefinition } from '../core/runner-definition.ts';
export type { AgentToolDefinition, AgentToolResult } from '../ci-wait/tool-registry.ts';
export type { WaitKindRow, WaitKindRegistration, WaitLifecycle, WaitInputDescriptor } from '../workflows/run/wait-kind-registry.ts';
export type { StepKindDefinition, StepKindContext, StepKindOutcome } from '../workflows/step-kind-registry.ts';
export type { CliCommandDefinition, RootCommandContext, SubcommandRunner } from '../core/cli-registry.ts';
export type { HttpRouteContext, HttpRouteDefinition, HttpRouteMethod } from '../core/http-route-registry.ts';
export type { RunSlots, DeletionGate, DeletionGateContext, DeletionKind, ReclaimPreparation, ReclaimContext, RemovalCleanup } from '../runs/removal-slots.ts';
export type { LaunchCockpitAddress, LaunchPartContext, LaunchPartContribution, LaunchPartDefinition } from '../core/launch-registry.ts';
export type { RunLifecycleHandlers, RunLifecycleHandler, RunLifecycleEvents, RunLifecycleEventType } from '../runs/lifecycle.ts';
export * from './runner-kit.ts';
