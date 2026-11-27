/**
 * The plugin API object and its transactional setup (spec 2026-11-24-plugin-loader-and-runner-kit
 * § 2). A plugin is a setup function. `runPluginSetup` hands it a `SquawkPluginApi` that only
 * stages each call. When setup ends without an error and every staged entry passes the checks
 * its live registry applies, all entries commit. Otherwise nothing commits and the error throws.
 */
import { checkAgentToolRegistration, registerAgentTool, type AgentToolDefinition } from '../ci-wait/tool-registry.ts';
import { checkCliCommandRegistration, registerCliCommand, type CliCommandDefinition } from '../core/cli-registry.ts';
import { checkHttpRouteRegistration, registerHttpRoute, type HttpRouteDefinition } from '../core/http-route-registry.ts';
import { checkLaunchPartRegistration, registerLaunchPart, type LaunchPartDefinition } from '../core/launch-registry.ts';
import type { RunnerDefinition } from '../core/runner-definition.ts';
import { checkRunnerRegistration, registerRunner } from '../core/runner-registry.ts';
import type { RunLifecycleHandlers } from '../runs/lifecycle.ts';
import { checkRunLifecycleListenerRegistration, registerRunLifecycleListener } from '../runs/lifecycle-registry.ts';
import { checkRunSlotsRegistration, registerRunSlots, type RunSlots } from '../runs/removal-slots.ts';
import { checkWaitKindRegistration, registerWaitKind, type WaitKindRow } from '../workflows/run/wait-kind-registry.ts';
import { checkStepKindRegistration, registerStepKind, type StepKindDefinition } from '../workflows/step-kind-registry.ts';

/** The register calls a plugin's setup function receives. Each call stages; nothing is live until setup ends. */
export interface SquawkPluginApi {
  registerRunner(definition: RunnerDefinition): void;
  registerAgentTool(tool: AgentToolDefinition): void;
  registerWaitKind(row: WaitKindRow): void;
  registerStepKind(step: StepKindDefinition): void;
  registerCliCommand(command: CliCommandDefinition): void;
  registerHttpRoute(route: HttpRouteDefinition): void;
  registerRemovalSlots(slots: Partial<RunSlots>): void;
  /** Add env entries and a system-prompt part to every agent launch. */
  registerLaunchPart(part: LaunchPartDefinition): void;
  onRunLifecycle(handlers: RunLifecycleHandlers): void;
}

/** A plugin module's default export. */
export type SquawkPlugin = (api: SquawkPluginApi) => void | Promise<void>;

function checkKey(registry: string, key: unknown): void {
  if (typeof key !== 'string' || key.length === 0) throw new Error(`${registry}: invalid key ${JSON.stringify(key)}.`);
}

/** One keyed registry as staging sees it: the key of an entry, its live check and its commit. */
interface KeyedTable<V> {
  name: string;
  key(value: V): unknown;
  shape?(value: V): void;
  check(value: V): void;
  commit(value: V): void;
}

const runners: KeyedTable<RunnerDefinition> = {
  name: 'Runner registry', key: value => value.id, check: checkRunnerRegistration, commit: registerRunner,
};
const tools: KeyedTable<AgentToolDefinition> = {
  name: 'Agent tool registry', key: value => value.name, check: checkAgentToolRegistration, commit: registerAgentTool,
};
const waitKinds: KeyedTable<WaitKindRow> = {
  name: 'wait-kind registry', key: value => value.kind,
  shape: value => { if (!Array.isArray(value.requestKinds)) throw new Error(`wait-kind registry: '${String(value.kind)}' needs a requestKinds array.`); },
  check: checkWaitKindRegistration, commit: registerWaitKind,
};
const stepKinds: KeyedTable<StepKindDefinition> = {
  name: 'Workflow step kinds', key: value => value.kind, check: checkStepKindRegistration, commit: registerStepKind,
};
const cliCommands: KeyedTable<CliCommandDefinition> = {
  name: 'CLI commands', key: value => value.name, check: checkCliCommandRegistration, commit: registerCliCommand,
};
const httpRoutes: KeyedTable<HttpRouteDefinition> = {
  name: 'HTTP routes', key: value => value.id, check: checkHttpRouteRegistration, commit: registerHttpRoute,
};
const launchParts: KeyedTable<LaunchPartDefinition> = {
  name: 'Launch parts', key: value => value.id, check: checkLaunchPartRegistration, commit: registerLaunchPart,
};

/** What one plugin's setup staged, in call order per registry. */
interface StagedPlugin {
  runners: RunnerDefinition[];
  tools: AgentToolDefinition[];
  waitKinds: WaitKindRow[];
  stepKinds: StepKindDefinition[];
  cliCommands: CliCommandDefinition[];
  httpRoutes: HttpRouteDefinition[];
  launchParts: LaunchPartDefinition[];
  removalSlots: Array<Partial<RunSlots>>;
  lifecycle: RunLifecycleHandlers[];
}

function checkKeyed<V>(table: KeyedTable<V>, values: readonly V[]): void {
  const staged = new Map<unknown, V>();
  for (const value of values) {
    const key = table.key(value);
    table.shape?.(value);
    table.check(value);
    checkKey(table.name, key);
    const earlier = staged.get(key);
    if (earlier !== undefined && earlier !== value) throw new Error(`${table.name}: the plugin registers '${String(key)}' twice.`);
    staged.set(key, value);
  }
}

/** Two staged wait kinds may not answer the same request kind. The live owners are `checkWaitKindRegistration`'s. */
function checkStagedRequestKinds(rows: readonly WaitKindRow[]): void {
  const owners = new Map<string, WaitKindRow>();
  for (const row of rows) {
    for (const kind of row.requestKinds) {
      const owner = owners.get(kind);
      if (owner && owner !== row) throw new Error(`wait-kind registry: the plugin registers request kind '${kind}' twice.`);
      owners.set(kind, row);
    }
  }
}

function checkSlots(slots: Partial<RunSlots>): void {
  for (const name of ['gates', 'preparations', 'cleanups'] as const) {
    const list = slots[name];
    if (list !== undefined && !Array.isArray(list)) throw new Error(`The removal slots: '${name}' must be an array.`);
  }
  checkRunSlotsRegistration(slots);
}

function checkStagedHttpPaths(routes: readonly HttpRouteDefinition[]): void {
  const owners = new Map<string, HttpRouteDefinition>();
  for (const route of routes) {
    const owner = owners.get(route.path);
    if (owner && owner !== route) throw new Error(`HTTP routes: the plugin registers path '${route.path}' twice.`);
    owners.set(route.path, route);
  }
}

function checkStaged(staged: StagedPlugin): void {
  checkKeyed(runners, staged.runners);
  checkKeyed(tools, staged.tools);
  checkKeyed(waitKinds, staged.waitKinds);
  checkStagedRequestKinds(staged.waitKinds);
  checkKeyed(stepKinds, staged.stepKinds);
  checkKeyed(cliCommands, staged.cliCommands);
  checkKeyed(httpRoutes, staged.httpRoutes);
  checkStagedHttpPaths(staged.httpRoutes);
  checkKeyed(launchParts, staged.launchParts);
  for (const slots of staged.removalSlots) checkSlots(slots);
  for (const handlers of staged.lifecycle) {
    if (typeof handlers !== 'object' || handlers === null) throw new Error('Run lifecycle listeners: handlers must be an object.');
    checkRunLifecycleListenerRegistration(handlers);
  }
}

function commitStaged(staged: StagedPlugin): void {
  for (const value of staged.runners) runners.commit(value);
  for (const value of staged.tools) tools.commit(value);
  for (const value of staged.waitKinds) waitKinds.commit(value);
  for (const value of staged.stepKinds) stepKinds.commit(value);
  for (const value of staged.cliCommands) cliCommands.commit(value);
  for (const value of staged.httpRoutes) httpRoutes.commit(value);
  for (const value of staged.launchParts) launchParts.commit(value);
  for (const slots of staged.removalSlots) registerRunSlots(slots);
  for (const handlers of staged.lifecycle) registerRunLifecycleListener(handlers);
}

function stagingApi(staged: StagedPlugin, open: () => boolean): SquawkPluginApi {
  const stage = <V>(list: V[]) => (value: V): void => {
    if (!open()) throw new Error('A plugin may register only while its setup function runs.');
    list.push(value);
  };
  return {
    registerRunner: stage(staged.runners),
    registerAgentTool: stage(staged.tools),
    registerWaitKind: stage(staged.waitKinds),
    registerStepKind: stage(staged.stepKinds),
    registerCliCommand: stage(staged.cliCommands),
    registerHttpRoute: stage(staged.httpRoutes),
    registerRemovalSlots: stage(staged.removalSlots),
    registerLaunchPart: stage(staged.launchParts),
    onRunLifecycle: stage(staged.lifecycle),
  };
}

/** The keys one plugin committed, per registry, in call order, and its list registration counts. */
export interface PluginContributions {
  runners: string[];
  agentTools: string[];
  waitKinds: string[];
  stepKinds: string[];
  cliCommands: string[];
  httpRoutes: string[];
  removalSlots: number;
  runLifecycleListeners: number;
  launchParts: string[];
}

function contributions(staged: StagedPlugin): PluginContributions {
  return {
    runners: staged.runners.map(value => value.id),
    agentTools: staged.tools.map(value => value.name),
    waitKinds: staged.waitKinds.map(value => value.kind),
    stepKinds: staged.stepKinds.map(value => value.kind),
    cliCommands: staged.cliCommands.map(value => value.name),
    httpRoutes: staged.httpRoutes.map(value => value.id),
    removalSlots: staged.removalSlots.length,
    runLifecycleListeners: staged.lifecycle.length,
    launchParts: staged.launchParts.map(value => value.id),
  };
}

/**
 * Run one plugin's setup and commit what it registered, all or nothing. A setup that throws or
 * rejects, or a staged entry that a live registry would refuse (a taken or reserved key, a
 * duplicate within the plugin, an invalid shape, a sealed registry), commits no entry anywhere and
 * rethrows that error. The api refuses calls once setup has ended. Returns what it committed.
 */
export async function runPluginSetup(plugin: SquawkPlugin): Promise<PluginContributions> {
  const staged: StagedPlugin = { runners: [], tools: [], waitKinds: [], stepKinds: [], cliCommands: [], httpRoutes: [], launchParts: [], removalSlots: [], lifecycle: [] };
  let open = true;
  try {
    await plugin(stagingApi(staged, () => open));
  } finally {
    open = false;
  }
  checkStaged(staged);
  commitStaged(staged);
  return contributions(staged);
}
