import { describe, expect, it } from 'vitest';
import { ruleCases } from './ast-rule.testkit.ts';
import { activeRunWriteRules } from './active-run-write.ts';
import { activeRunLiteral, activeRunMapWrite } from './active-run.ts';

/** Every former YAML case, unchanged (hearsay-tools/squawk#3774). */

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-boundary-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const view = state.boundary; view.idleTimer;",
    "class BoundaryGroup { #idleTimer; get idleTimer() { return this.#idleTimer; } }",
    "function createActiveRun() { Object.defineProperty(container, \"boundary\", { writable: false, configurable: false }); }",
    "const unrelated = {}; Object.assign(unrelated, { value: 1 });"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.boundary = other.boundary; }",
    "function f(state: ActiveRun) { state[\"boundary\"] = other.boundary; }",
    "function f(state: ActiveRun) { delete state.boundary; }",
    "function f(state: ActiveRun) { state.boundary ??= other.boundary; }",
    "state.boundary.idleTimer = replacement;",
    "delete state.boundary.idleTimer;",
    "state.boundary.idleTimer++;",
    "const view = state.boundary; view.idleTimer = replacement;",
    "function f(state: ActiveRun) { const { boundary: view } = state; view.idleTimer = replacement; }",
    "function f(view: BoundaryGroup) { view.idleTimer = replacement; }",
    "import type { BoundaryGroup as View } from \"./turn-boundary.ts\"; function f(view: View) { Object.assign(view, { idleTimer: replacement }); }",
    "state.boundary as any",
    "state.boundary as unknown",
    "state.boundary as unknown as Mutable",
    "<Mutable>state.boundary",
    "const view = state.boundary; view as any;",
    "({ ...state.boundary }) as BoundaryGroup",
    "Object.assign(state.boundary, { idleTimer: replacement });",
    "Object.defineProperty(state.boundary, \"idleTimer\", { value: replacement });",
    "Object.defineProperties(state.boundary, { idleTimer: { value: replacement } });",
    "Reflect.defineProperty(state.boundary, \"idleTimer\", { value: replacement });",
    "Reflect.set(state.boundary, \"idleTimer\", replacement);",
    "Object.setPrototypeOf(state.boundary, other);",
    "Reflect.setPrototypeOf(state.boundary, other);",
    "Reflect.deleteProperty(state.boundary, \"idleTimer\");",
    "Object.assign(state.boundary, { ...other });",
    "function f(state: ActiveRun) { Object.assign(state, { boundary: other.boundary }); }",
    "const state = createActiveRun(init); Object.assign(state, { boundary: other.boundary });",
    "function f(state: ActiveRun) { const alias = state; alias.boundary = other.boundary; }",
    "function f(target: ActiveRun, key: string, replacement: BoundaryGroup) { Reflect.set(target, key, replacement); }",
    "class BoundaryGroup { readonly backing = {}; }",
    "const view = createBoundaryGroup(); Object.assign(view, { idleTimer: replacement });",
    "const { doneClose: close } = state.boundary; Object.assign(close, { summary: \"forged\" });",
    "const close = state.boundary.doneClose; close.summary = \"forged\";",
    "function f(view: DoneRequest) { view.summary = \"forged\"; }",
    "state.boundary[\"parkAfterAck\"].monitoring = true;",
    "state.boundary.nudge = undefined;",
    "const nudge = state.boundary.nudge; nudge.state = \"refused\";",
    "function f(view: Nudge) { view.cause = \"autonomous\"; }",
    "function f(state: ActiveRun) { const { boundary: view } = state; Object.defineProperty(view, \"pendingHumanAsk\", { value: true }); }"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-wait-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const view = state.waitIdentity; view.ciTurnId;",
    "class WaitGroup { #ciTurnId; get ciTurnId() { return this.#ciTurnId; } }",
    "function createActiveRun() { Object.defineProperty(container, \"waitIdentity\", { writable: false, configurable: false }); }",
    "const unrelated = {}; Object.assign(unrelated, { value: 1 });"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.waitIdentity = other.waitIdentity; }",
    "function f(state: ActiveRun) { state[\"waitIdentity\"] = other.waitIdentity; }",
    "function f(state: ActiveRun) { delete state.waitIdentity; }",
    "function f(state: ActiveRun) { state.waitIdentity ??= other.waitIdentity; }",
    "state.waitIdentity.ciTurnId = replacement;",
    "delete state.waitIdentity.ciTurnId;",
    "state.waitIdentity.ciTurnId++;",
    "const view = state.waitIdentity; view.ciTurnId = replacement;",
    "function f(state: ActiveRun) { const { waitIdentity: view } = state; view.ciTurnId = replacement; }",
    "function f(view: WaitGroup) { view.ciTurnId = replacement; }",
    "import type { WaitGroup as View } from \"./wait-registry.ts\"; function f(view: View) { Object.assign(view, { ciTurnId: replacement }); }",
    "state.waitIdentity as any",
    "state.waitIdentity as unknown",
    "state.waitIdentity as unknown as Mutable",
    "<Mutable>state.waitIdentity",
    "const view = state.waitIdentity; view as any;",
    "({ ...state.waitIdentity }) as WaitGroup",
    "Object.assign(state.waitIdentity, { ciTurnId: replacement });",
    "Object.defineProperty(state.waitIdentity, \"ciTurnId\", { value: replacement });",
    "Object.defineProperties(state.waitIdentity, { ciTurnId: { value: replacement } });",
    "Reflect.defineProperty(state.waitIdentity, \"ciTurnId\", { value: replacement });",
    "Reflect.set(state.waitIdentity, \"ciTurnId\", replacement);",
    "Object.setPrototypeOf(state.waitIdentity, other);",
    "Reflect.setPrototypeOf(state.waitIdentity, other);",
    "Reflect.deleteProperty(state.waitIdentity, \"ciTurnId\");",
    "Object.assign(state.waitIdentity, { ...other });",
    "function f(state: ActiveRun) { Object.assign(state, { waitIdentity: other.waitIdentity }); }",
    "const state = createActiveRun(init); Object.assign(state, { waitIdentity: other.waitIdentity });",
    "function f(state: ActiveRun) { const alias = state; alias.waitIdentity = other.waitIdentity; }",
    "function f(target: ActiveRun, key: string, replacement: WaitGroup) { Reflect.set(target, key, replacement); }",
    "class WaitGroup { readonly backing = {}; }",
    "const view = createWaitGroup(); Object.assign(view, { ciTurnId: replacement });"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-autosave-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const view = state.autosave; view.autosaveTimer;",
    "class AutosaveGroup { #autosaveTimer; get autosaveTimer() { return this.#autosaveTimer; } }",
    "function createActiveRun() { Object.defineProperty(container, \"autosave\", { writable: false, configurable: false }); }",
    "const unrelated = {}; Object.assign(unrelated, { value: 1 });"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.autosave = other.autosave; }",
    "function f(state: ActiveRun) { state[\"autosave\"] = other.autosave; }",
    "function f(state: ActiveRun) { delete state.autosave; }",
    "function f(state: ActiveRun) { state.autosave ??= other.autosave; }",
    "state.autosave.autosaveTimer = replacement;",
    "delete state.autosave.autosaveTimer;",
    "state.autosave.autosaveTimer++;",
    "const view = state.autosave; view.autosaveTimer = replacement;",
    "const { autosave: view } = state; view.autosaveTimer = replacement;",
    "function f(view: AutosaveGroup) { view.autosaveTimer = replacement; }",
    "import type { AutosaveGroup as View } from \"./worktree-autosave.ts\"; function f(view: View) { Object.assign(view, { autosaveTimer: replacement }); }",
    "state.autosave as any",
    "state.autosave as unknown",
    "state.autosave as unknown as Mutable",
    "<Mutable>state.autosave",
    "const view = state.autosave; view as any;",
    "({ ...state.autosave }) as AutosaveGroup",
    "Object.assign(state.autosave, { autosaveTimer: replacement });",
    "Object.defineProperty(state.autosave, \"autosaveTimer\", { value: replacement });",
    "Object.defineProperties(state.autosave, { autosaveTimer: { value: replacement } });",
    "Reflect.defineProperty(state.autosave, \"autosaveTimer\", { value: replacement });",
    "Reflect.set(state.autosave, \"autosaveTimer\", replacement);",
    "Object.setPrototypeOf(state.autosave, other);",
    "Reflect.setPrototypeOf(state.autosave, other);",
    "Reflect.deleteProperty(state.autosave, \"autosaveTimer\");",
    "Object.assign(state.autosave, { ...other });",
    "function f(state: ActiveRun) { Object.assign(state, { autosave: other.autosave }); }",
    "const state = createActiveRun(init); Object.assign(state, { autosave: other.autosave });",
    "function f(state: ActiveRun) { const alias = state; alias.autosave = other.autosave; }",
    "function f(target: ActiveRun, key: string, replacement: AutosaveGroup) { Reflect.set(target, key, replacement); }",
    "class AutosaveGroup { readonly backing = {}; }",
    "const view = createAutosaveGroup(); Object.assign(view, { autosaveTimer: replacement });"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-input-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const flight = state.inputState.agentInputFlight; flight?.settled;",
    "const ids = state.inputState.unreadInputIds; ids?.has('id');",
    "state.inputState.forgetRetiredInput('id'); state.inputState.clearHeldTimer();",
    "modules.inputDelivery = new InputDelivery(context, host);",
    "const unrelated = {}; Object.assign(unrelated, { inputDelivery: policy });",
    "class InputGroup { #writingInput; get writingInput() { return this.#writingInput; } }",
    "function createActiveRun() { Object.defineProperty(container, \"inputState\", { writable: false, configurable: false }); }"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.inputState = other.inputState; }",
    "function f(state: ActiveRun) { state[\"inputState\"] = other.inputState; }",
    "function f(state: ActiveRun) { delete state.inputState; }",
    "function f(state: ActiveRun) { state.inputState ??= other.inputState; }",
    "state.inputState.agentInputError = 'forged';",
    "state.inputState.agentInputFlight.wakeReserved = false;",
    "state.inputState.agentInputFlight.settled = promise;",
    "state.inputState.openingAnswerAskSeq++;",
    "state.inputState.unreadInputIds.add('forged');",
    "state.inputState.consumedBeforeAck['delete']('id');",
    "state.inputState.bundledInputIds.push('forged');",
    "state.inputState.agentInputFlight.inputIds.push('forged');",
    "state.inputState.inputDelivery.consumption = 'unobservable';",
    "const view = state.inputState.retiredInFlight; view.clear();",
    "const { unreadInputIds: ids } = state.inputState; ids.clear();",
    "const { agentInputFlight: flight } = state.inputState; flight.wakeReserved = false;",
    "function f(view: InputGroup) { view.writingInput = true; }",
    "function f(view: InputFlight) { view.wakeReserved = true; }",
    "import type { InputGroup as InputView } from \"./input-delivery.ts\"; function f(view: InputView) { Object.assign(view, { writingInput: true }); }",
    "state.inputState as any",
    "state.inputState as unknown",
    "state.inputState as unknown as MutableInput",
    "state.inputState.unreadInputIds as Set<string>",
    "<Set<string>>state.inputState.retiredInFlight",
    "const view = state.inputState; view as any;",
    "function f(state: ActiveRun) { const { inputState: view } = state; view as unknown as MutableInput; }",
    "({ ...state.inputState }) as InputGroup",
    "Object.assign(state.inputState, { writingInput: true });",
    "Object.defineProperty(state.inputState, \"agentInputError\", { value: \"forged\" });",
    "Object.defineProperties(state.inputState, { writingInput: { value: true } });",
    "Reflect.defineProperty(state.inputState.agentInputFlight, \"wakeReserved\", { value: true });",
    "Reflect.set(state.inputState, \"openingAgentInputId\", \"forged\");",
    "Object.setPrototypeOf(state.inputState, other);",
    "Reflect.setPrototypeOf(state.inputState, other);",
    "Reflect.deleteProperty(state.inputState, \"writingInput\");",
    "Object.assign(state.inputState, { ...other });",
    "function f(state: ActiveRun) { Object.assign(state, { inputState: other.inputState }); }",
    "const state = createActiveRun(init); Object.assign(state, { inputState: other.inputState });",
    "function f(state: ActiveRun) { const alias = state; alias.inputState = other.inputState; }",
    "function f(target: ActiveRun, key: string, replacement: InputGroup) { Reflect.set(target, key, replacement); }",
    "class InputGroup { readonly backing = new Set(); }",
    "class InputFlight { readonly inputIds = []; }",
    "const view = createInputGroup(); Object.assign(view, { writingInput: true });"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-session-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const session = state.liveSession.session; session?.interrupt();",
    "const view = state.liveSession.pendingPermissions; view.has('request');",
    "const settings = state.liveSession.delegationSettings; structuredClone(settings);",
    "state.liveSession.cancel(); state.liveSession.installInterrupt(stop);",
    "const unrelated = {}; Object.assign(unrelated, { cwd: \"/other\" });",
    "event.session = session; runner.cwd = \"/other\";",
    "class SessionGroup { #session; get session() { return this.#session; } }",
    "function createActiveRun() { Object.defineProperty(container, \"liveSession\", { writable: false, configurable: false }); }"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.liveSession = other.liveSession; }",
    "function f(state: ActiveRun) { state[\"liveSession\"] = other.liveSession; }",
    "function f(state: ActiveRun) { delete state.liveSession; }",
    "function f(state: ActiveRun) { state.liveSession ??= other.liveSession; }",
    "state.liveSession.cancelled = true;",
    "state.liveSession.session = session;",
    "state.liveSession.ciGeneration++;",
    "state.liveSession.pendingPermissions.add('forged');",
    "state.liveSession.pendingPermissions['delete']('request');",
    "state.liveSession.delegationSettings.allowedTools.push('forged');",
    "state.liveSession.delegationSettings.accountBinding.claudeLayout.kind = 'relocated';",
    "const view = state.liveSession.pendingPermissions; view.clear();",
    "const { pendingPermissions: grants } = state.liveSession; grants.clear();",
    "const { delegationSettings: settings } = state.liveSession; settings.allowedTools.push(\"forged\");",
    "function f(view: SessionGroup) { view.cwd = \"/other\"; }",
    "function f(view: SessionGroup) { view.pendingPermissions.clear(); }",
    "import type { SessionGroup as SessionView } from \"./live-session-state.ts\"; function f(view: SessionView) { Object.assign(view, { cwd: \"/other\" }); }",
    "state.liveSession as any",
    "state.liveSession as unknown",
    "state.liveSession as unknown as MutableSession",
    "state.liveSession.pendingPermissions as Set<string>",
    "<Set<string>>state.liveSession.pendingPermissions",
    "const view = state.liveSession; view as any;",
    "function f(state: ActiveRun) { const { liveSession: view } = state; view as unknown as MutableSession; }",
    "({ ...state.liveSession }) as SessionGroup",
    "Object.assign(state.liveSession, { cancelled: true });",
    "Object.defineProperty(state.liveSession, \"session\", { value: other });",
    "Object.defineProperties(state.liveSession, { session: { value: other } });",
    "Reflect.defineProperty(state.liveSession, \"cwd\", { value: \"/other\" });",
    "Reflect.set(state.liveSession, \"session\", other);",
    "Object.setPrototypeOf(state.liveSession, other);",
    "Reflect.setPrototypeOf(state.liveSession, other);",
    "Reflect.deleteProperty(state.liveSession, \"cwd\");",
    "Object.assign(state.liveSession, { ...other });",
    "function f(state: ActiveRun) { Object.assign(state, { liveSession: other.liveSession }); }",
    "const state = createActiveRun(init); Object.assign(state, { liveSession: other.liveSession });",
    "function f(state: ActiveRun) { const alias = state; alias.liveSession = other.liveSession; }",
    "function f(target: ActiveRun, key: string, replacement: SessionGroup) { Reflect.set(target, key, replacement); }",
    "class SessionGroup { readonly backing = new Set(); }",
    "const view = createSessionGroup(\".\"); Object.assign(view, { cwd: \"/other\" });"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-usage-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const value = state.usage.usageInvocation?.observed",
    "const view = state.usage.startedTurns; view.has(\"turn\")",
    "const { startedTurns: turns } = invocation; turns.has(\"turn\")",
    "const snapshot = { ...state.usage }",
    "const unrelated = {}; Object.assign(unrelated, { observed: true })",
    "event.usage = { input: 1, output: 2 }",
    "const value = event.usage as { input: number }",
    "class UsageGroup { #cost = new Map(); get cost() { return this.#cost; } }",
    "function createActiveRun() { Object.defineProperty(container, 'usage', { value: new UsageGroup(), writable: false, configurable: false }); return container; }",
    "function f(state: ActiveRun) { state.cancelled = true; state.pendingPermissions?.add('x'); }",
    "const state = createActiveRun(init); state.cancelled = true; state.pendingPermissions?.add('x');",
    "function f(state: ActiveRun) { const alias = state; alias.cancelled = true; alias.pendingPermissions?.add('x'); }",
    "const value = event.usage; event.usage = { input: 1, output: 2 };",
    "const value = event['usage']; event['usage'] = { input: 1, output: 2 };",
    "class UsageGroup { #cost; #costs; check() { function owner(group: UsageGroup) { group.#cost = 1; group.#costs.set('x', 1); } } }",
    "class UsageInvocation { #observed; #startedTurns; check() { function owner(invocation: UsageInvocation) { invocation.#observed = true; invocation.#startedTurns.add('x'); } } }"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.usage = other.usage; }",
    "function f(state: ActiveRun) { state[\"usage\"] = other.usage; }",
    "function f(state: ActiveRun) { delete state.usage; }",
    "function f(state: ActiveRun) { state.usage ??= other.usage; }",
    "state.usage.usageInvocation.observed = true",
    "state.usage.usageInvocation.epoch++",
    "state.usage.cumulativeSessionCost.set(\"session\", 1)",
    "state.usage.usageInvocation.startedTurns.add(\"turn\")",
    "state.usage.usageInvocation.recordedTurns.clear()",
    "state.usage.usageInvocation.startedTurns[\"add\"](\"turn\")",
    "const view = state.usage.cumulativeSessionCost; view.set(\"session\", 1)",
    "const { cumulativeSessionCost: costs } = state.usage; costs.clear()",
    "const { startedTurns } = state.usage.usageInvocation; startedTurns.add(\"turn\")",
    "function f(view: ReadonlySetView) { view.add(\"turn\"); }",
    "function f(view: ReadonlySetView) { Object.assign(view, {}); }",
    "import type { ReadonlySetView as Turns } from \"./usage-accounting.ts\"; function f(view: Turns) { Reflect.set(view, \"size\", 1); }",
    "state.usage.cumulativeSessionCost as Map<string, number>",
    "state.usage.usageInvocation.startedTurns as Set<string>",
    "state.usage as any",
    "state.usage as unknown",
    "state.usage as unknown as MutableUsage",
    "<Map<string, number>>state.usage.cumulativeSessionCost",
    "const view = state.usage.usageInvocation; view as any",
    "const { usageInvocation: view } = state.usage; view as unknown as MutableUsage",
    "({ ...state.usage }) as UsageGroup",
    "Object.assign(state.usage, { usageInvocation: other })",
    "const view = state.usage.usageInvocation; Object.assign(view, { observed: true })",
    "Object.defineProperty(state.usage, \"usageInvocation\", { value: other })",
    "Object.defineProperties(state.usage, { usageInvocation: { value: other } })",
    "Reflect.defineProperty(state.usage, \"usageInvocation\", { value: other })",
    "Reflect.set(state.usage, \"usageInvocation\", other)",
    "Object.setPrototypeOf(state.usage, other)",
    "Reflect.setPrototypeOf(state.usage, other)",
    "Reflect.deleteProperty(state.usage, \"usageInvocation\")",
    "Object.assign(state.usage, { ...other })",
    "function f(state: ActiveRun) { Object.assign(state, { usage: other.usage }); }",
    "const state = createActiveRun(init); Object.assign(state, { usage: other.usage })",
    "function f(state: ActiveRun) { Object.defineProperty(state, \"usage\", { value: other.usage }); }",
    "function f(target: ActiveRun, key: string, replacement: UsageGroup) { Object.assign(target, { [key]: replacement }); }",
    "function f(target: ActiveRun, key: string, replacement: UsageGroup) { Reflect.set(target, key, replacement); }",
    "class UsageGroup { mutable = {}; }",
    "class UsageInvocation { readonly mutable = new Set(); }",
    "class ReadonlyMapView { backing = new Map(); }",
    "class ReadonlySetView { backing = new Set(); }",
    "function f(state: ActiveRun) { const alias = state; alias.usage = other.usage; }",
    "function f(state: ActiveRun) { const alias = state; Object.assign(alias, { usage: other.usage }); }",
    "function f(group: UsageGroup) { group.cumulativeSessionCost.clear(); }",
    "function f(invocation: UsageInvocation) { invocation.observed = true; }",
    "const view = new ReadonlyMapView(backing); view as Map<string, number>",
    "const view = createUsageGroup(); Object.assign(view, { usageInvocation: other })"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-skills-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "request.query.cache.clear(); foo.account.set(key, value);",
    "const shared: Skill = entry; shared.team = { repo: \"other\", ref: \"main\", path: \"demo\", dir: false };",
    "const view = state.skills.catalog; view[0];",
    "const { catalog: skills } = state.skills; [...skills];",
    "function f(state: ActiveRun) { state.session = session; state.cancelled = true; }",
    "const other = {}; Object.assign(other, { status: \"running\" });",
    "class SkillsGroup { #skills = new Map(); get catalog() { return this.#skills; } }",
    "function createActiveRun() { Object.defineProperty(state, \"skills\", { writable: false, configurable: false }); }"
  ],
  "invalid": [
    "function f(view: SkillsGroup) { view.query.accountHome = other; }",
    "const { query } = state.skills; Object.assign(query, { cwd: other });",
    "function f(state: ActiveRun) { state.skills = other.skills; }",
    "function f(state: ActiveRun) { delete state[\"skills\"]; }",
    "state.skills.catalog.push(value)",
    "state.skills.catalog[\"pop\"]()",
    "const map = state.skills.catalog; map.splice(0, 1)",
    "const { catalog: map } = state.skills; map.sort()",
    "const child = state.skills.catalog[0]; child.description = \"failed\"",
    "const child = state.skills.catalog[0]; Object.assign(child, { path: \"changed\" })",
    "state.skills.query.accountHome = other",
    "state.skills.account = \"other\"",
    "state.skills.unavailableReason = undefined",
    "function f(view: SkillsGroup) { Object.assign(view, { catalog: new Map() }); }",
    "import type { SkillsGroup as Children } from \"./run-skills.ts\"; function f(view: Children) { Reflect.set(view, \"catalog\", new Map()); }",
    "state.skills.catalog as Map<string, Child>",
    "<Map<string, Child>>state.skills.catalog",
    "const view = state.skills; view as any",
    "const { catalog: view } = state.skills; view as unknown as Map<string, Child>",
    "({ ...state.skills }) as SkillsGroup",
    "Object.assign(state.skills, { ...other })",
    "Object.defineProperty(state.skills, \"catalog\", { value: other })",
    "const view = state.skills.catalog; Object.defineProperties(view, { size: { value: 0 } })",
    "Reflect.defineProperty(state.skills, \"catalog\", { value: other })",
    "Reflect.set(state.skills, \"catalog\", other)",
    "Object.setPrototypeOf(state.skills, other)",
    "Reflect.setPrototypeOf(state.skills, other)",
    "function f(state: ActiveRun) { Object.assign(state, { skills: other.skills }); }",
    "const state = createActiveRun(init); const alias = state; Object.assign(alias, { skills: other.skills })",
    "function f(target: ActiveRun, key: string, replacement: SkillsGroup) { Object.assign(target, { [key]: replacement }); }",
    "class SkillsGroup { skills = new Map(); }",
    "class SkillsGroup { readonly backing = new Map(); }",
    "const view = createSkillsGroup(); view as any",
    "state.skills.catalog[0] = other",
    "const view = state.skills.catalog; view[0] = other",
    "const { catalog } = state.skills; catalog.push(other)",
    "state.skills.catalog[0].path = \"forged\"",
    "const skill = state.skills.catalog[0]; skill.scope = \"forged\"",
    "function f(view: SkillsGroup) { Reflect.set(view, \"query\", \"forged\") }"
  ]
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-children-write-outside-owner')!, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const view = state.children.backgroundChildren; view.get(\"child\");",
    "const { backgroundChildren: children } = state.children; [...children.values()];",
    "function f(state: ActiveRun) { state.session = session; state.cancelled = true; }",
    "const other = {}; Object.assign(other, { status: \"running\" });",
    "class ChildrenGroup { #children = new Map(); get backgroundChildren() { return this.#children; } }",
    "function createActiveRun() { Object.defineProperty(state, \"children\", { writable: false, configurable: false }); }"
  ],
  "invalid": [
    "function f(state: ActiveRun) { state.children = other.children; }",
    "function f(state: ActiveRun) { delete state[\"children\"]; }",
    "state.children.backgroundChildren.set(\"child\", value)",
    "state.children.backgroundChildren[\"clear\"]()",
    "const map = state.children.backgroundChildren; map.delete(\"child\")",
    "const { backgroundChildren: map } = state.children; map.clear()",
    "const child = state.children.backgroundChildren.get(\"child\"); child.status = \"failed\"",
    "const child = state.children.backgroundChildren.get(\"child\"); Object.assign(child, { status: \"failed\" })",
    "state.children.backgroundChildren.get(\"child\").session = other",
    "function f(view: ChildrenGroup) { Object.assign(view, { backgroundChildren: new Map() }); }",
    "import type { ChildrenGroup as Children } from \"./subagent-waits.ts\"; function f(view: Children) { Reflect.set(view, \"backgroundChildren\", new Map()); }",
    "state.children.backgroundChildren as Map<string, Child>",
    "<Map<string, Child>>state.children.backgroundChildren",
    "const view = state.children; view as any",
    "const { backgroundChildren: view } = state.children; view as unknown as Map<string, Child>",
    "({ ...state.children }) as ChildrenGroup",
    "Object.assign(state.children, { ...other })",
    "Object.defineProperty(state.children, \"backgroundChildren\", { value: other })",
    "const view = state.children.backgroundChildren; Object.defineProperties(view, { size: { value: 0 } })",
    "Reflect.defineProperty(state.children, \"backgroundChildren\", { value: other })",
    "Reflect.set(state.children, \"backgroundChildren\", other)",
    "Object.setPrototypeOf(state.children, other)",
    "Reflect.setPrototypeOf(state.children, other)",
    "function f(state: ActiveRun) { Object.assign(state, { children: other.children }); }",
    "const state = createActiveRun(init); const alias = state; Object.assign(alias, { children: other.children })",
    "function f(target: ActiveRun, key: string, replacement: ChildrenGroup) { Object.assign(target, { [key]: replacement }); }",
    "class ChildrenGroup { children = new Map(); }",
    "class ReadonlyMapView { readonly backing = new Map(); }",
    "const view = createChildrenGroup(); view as any"
  ]
});

ruleCases(activeRunLiteral, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "const state = this.makeActiveRun()",
    "const other: Other = { a: 1 }",
    "const run = state as ActiveRun",
    "const run = { a: 1 } as Other",
    "const state: ActiveRun = this.build()"
  ],
  "invalid": [
    "const state: ActiveRun = { a: 1 }",
    "let state: ActiveRun = { a: 1 }",
    "const state = { a: 1 } as ActiveRun",
    "const state = { a: 1 } as unknown as ActiveRun",
    "const state = { a: 1 } satisfies ActiveRun",
    "const state = { ...base, a: 1 } as ActiveRun"
  ]
});

ruleCases(activeRunMapWrite, {
  "file": "packages/cezar/src/workflows/run/example.ts",
  "valid": [
    "class RunManager { activate(id, state) { this.active.set(id, state); } }",
    "class RunManager { dropActive(id) { this.active.delete(id); } }",
    "class RunManager { execute(id, state) { this.activate(id, state); this.dropActive(id); } }",
    "class RunManager { execute(id) { this.active.get(id); this.waiting.delete(id); } }",
    "function inspect(host, id) { host.active.get(id); host.active.has(id); }"
  ],
  "invalid": [
    "class RunManager { execute(id, state) { this.active.set(id, state); } }",
    "class RunManager { execute(id) { this.active.delete(id); } }",
    "class RunManager { activate(id) { this.active.delete(id); } }",
    "class RunManager { dropActive(id, state) { this.active.set(id, state); } }",
    "class RunManager {\nexecute(id, state) {\nif (state) {\nthis.active.set(id, state);\n}\n}\n}\n",
    "class RunManager { activate() { class Other { execute(id, state) { this.active.set(id, state); } } } }",
    "class RunManager { dropActive() { class Other { execute(id) { this.active.delete(id); } } } }",
    "class Part { execute(id, state) { this.host.active.set(id, state); } }",
    "class Part { execute(id) { this.host.active.delete(id); } }",
    "function release(host, id) { host.active.delete(id); }",
    "class Part { activate(id, state) { this.host.active.set(id, state); } }",
    "class Part { dropActive(id) { this.host.active.delete(id); } }",
    "class Part { activate(id, state) { this.active.set(id, state); } }",
    "class Part { dropActive(id) { this.active.delete(id); } }",
    "class RunManager { activate(id, state) { this.host.active.set(id, state); } }",
    "class RunManager { dropActive(id) { host.active.delete(id); } }",
    "class RunManager { other() { const nested = { activate(id, state) { this.active.set(id, state); } }; } }",
    "class RunManager { other() { const nested = { dropActive(id) { this.active.delete(id); } }; } }",
    "class RunManager { activate() { const nested = { activate(id, state) { this.active.set(id, state); } }; } }",
    "class RunManager { dropActive() { const nested = { dropActive(id) { this.active.delete(id); } }; } }"
  ]
});

describe('active-run rule scopes', () => {
  it('keeps literal and owner rules in server TypeScript, including tests', () => {
    for (const rule of [activeRunLiteral, ...activeRunWriteRules]) {
      expect(rule.applies('packages/cezar/src/workflows/example.test.ts')).toBe(true);
      expect(rule.applies('packages/cezar/src/workflows/example.testkit.ts')).toBe(true);
      expect(rule.applies('packages/web/src/example.ts')).toBe(false);
      expect(rule.applies('packages/cezar/src/example.tsx')).toBe(false);
    }
  });
  it('keeps map writes in production workflow files', () => {
    expect(activeRunMapWrite.applies('packages/cezar/src/workflows/run/example.ts')).toBe(true);
    for (const file of ['packages/cezar/src/workflows/example.test.ts', 'packages/cezar/src/workflows/example.testkit.ts', 'packages/cezar/src/core/example.ts']) {
      expect(activeRunMapWrite.applies(file)).toBe(false);
    }
  });
});

// ESTree drops tree-sitter's parenthesized_expression node, splits parameter type
// annotations onto identifiers, and represents both computed/dot access as MemberExpression.
ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-boundary-write-outside-owner')!, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'const group = state.boundary; const alias = group; alias.idleTimer = value;',
    'state[`boundary`] = replacement;',
    'state.boundary[`clear`]();',
    'function f(view: BoundaryGroup) { unrelated.view.idleTimer = value; }',
    'const view = state.boundary; unrelated.view.idleTimer = value;',
  ],
  invalid: [
    'const copy = { ...state.boundary } as Mutable;',
    '(state.boundary).idleTimer = value;',
    'state.boundary!.idleTimer = value;',
    'state.boundary["idleTimer"] = value;',
    'function f(group?: BoundaryGroup) { group.idleTimer = value; }',
    'const group: BoundaryGroup = getGroup(); group.idleTimer = value;',
    'function f(target: AR) { const { boundary } = target; boundary.idleTimer = value; } import type { ActiveRun as AR } from "./active-run.ts";',
    'function f(group: View) { group.idleTimer = value; } import type { BoundaryGroup as View } from "./turn-boundary.ts";',
    'const group = manager.active.get(id)!; group.boundary.idleTimer = value;',
    '<Mutable>({ copied: state.boundary });',
    'class BoundaryGroup { field: unknown; }',
    'class BoundaryGroup { readonly field: unknown; }',
  ],
});

ruleCases(activeRunLiteral, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'function build(): ActiveRun { return {}; }',
    'const state: ActiveRun | undefined = {};',
    'var state: ActiveRun = {};',
    'const other = 1, state: ActiveRun = {};',
    'const state = {} as Other as ActiveRun;',
    'const state = {} satisfies Other;',
  ],
  invalid: [
    '({ ...base }) as ActiveRun;',
    '({}) satisfies ActiveRun;',
    'const state: ActiveRun = ({});',
    'const state: ActiveRun = {}, other = 1;',
    'const state: ActiveRun<X> = {};',
    'const state = {} as ActiveRun<X>;',
    'const state = {} satisfies ActiveRun<X>;',
  ],
});

ruleCases(activeRunMapWrite, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'host["active"].set(id, state);',
    'host.active["set"](id, state);',
    'const active = host.active; active.set(id, state);',
    'class RunManager { #active; execute() { this.#active.set(id, state); } }',
    'class RunManager { activate() { const write = () => this.active.set(id, state); } }',
  ],
  invalid: [
    'class RunManager { activate() { return { dropActive() { this.active.delete(id); } }; } }',
    'class RunManager { [activate]() { this.active.set(id, state); } }',
  ],
});


// Review B1/B2: parenthesized receivers and angle assertions kept a descendant
// search in tree-sitter. ESTree drops the parentheses, so exercise each owner.
for (const [group, slot, type, field] of [
  ['autosave', 'autosave', 'AutosaveGroup', 'autosaveTimer'],
  ['boundary', 'boundary', 'BoundaryGroup', 'idleTimer'],
  ['children', 'children', 'ChildrenGroup', 'status'],
  ['input', 'inputState', 'InputGroup', 'writingInput'],
  ['session', 'liveSession', 'SessionGroup', 'cancelled'],
  ['skills', 'skills', 'SkillsGroup', 'path'],
  ['usage', 'usage', 'UsageGroup', 'observed'],
  ['wait', 'waitIdentity', 'WaitGroup', 'ciTurnId'],
]) {
  ruleCases(activeRunWriteRules.find(rule => rule.name === `active-run-${group}-write-outside-owner`)!, {
    file: 'packages/cezar/src/workflows/run/example.ts',
    valid: [
      `Object.assign((flag ? unrelated : fallback), { ${field}: replacement });`,
      `Object.assign((identity(unrelated)), { ${field}: replacement });`,
      `function f(group: Other) { const alias = (identity(group)); Object.assign(alias, { ${field}: replacement }); }`,
    ],
    invalid: [
      `(flag ? state.${slot} : fallback).${field} = replacement;`,
      `(identity(state.${slot})).${field} = replacement;`,
      `function f(group: ${type}) { const alias = (identity(group)); alias.${field} = replacement; }`,
      `(state.${slot} || fallback).${field} = replacement;`,
      `async function f() { (await state.${slot}).${field} = replacement; }`,
      `(state.${slot} satisfies ${type}).${field} = replacement;`,
      `(fallback, state.${slot}).${field} = replacement;`,
      `<Mutable>identity(state.${slot});`,
      `<Mutable>{ group: state.${slot} };`,
      `function f(group: ${type}) { group.${field} = replacement; }`,
    ],
  });
}


ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-usage-write-outside-owner')!, {
  file: 'packages/cezar/src/workflows/run/usage-accounting.ts',
  valid: [
    'const costs = usageWrites.costs(state.usage); costs.set(sessionKey, Math.max(previous, reportedUsd));',
    'function f(group: UsageGroup) { Object.assign(identity(group)); }',
    'function f(group: UsageGroup) { Object.assign<Mutable>(identity(group)); }',
    'function f(group: UsageGroup) { const alias = flag ? group : fallback; alias.observed = true; }',
    'function f(group: UsageGroup) { const alias = group || fallback; alias.observed = true; }',
  ],
  invalid: [
    '( /* group */ identity(state.usage) /* view */ ).observed = true;',
    'function f(group: UsageGroup) { Object.assign((identity(group))); }',
    'function f(group: UsageGroup) { Object.assign<Mutable>((identity(group))); }',
  ],
});


// Counts measured against the deleted 9f43ee092 YAML with the former parser on stdin.
// Keep the JSON table readable by .ai/qa/3774/compare-owner-expressions.mjs.
const OWNER_EXPRESSION_SHAPES = [
  {"name": "member", "expression": "GROUP.value", "bare": 1, "wrapped": 1},
  {"name": "call", "expression": "identity(GROUP)", "bare": 0, "wrapped": 1},
  {"name": "new", "expression": "new Holder(GROUP)", "bare": 0, "wrapped": 1},
  {"name": "await", "expression": "await GROUP", "bare": 0, "wrapped": 1},
  {"name": "yield", "expression": "yield GROUP", "bare": 0, "wrapped": 1},
  {"name": "conditional", "expression": "flag ? GROUP : fallback", "bare": 0, "wrapped": 1},
  {"name": "logical", "expression": "GROUP || fallback", "bare": 0, "wrapped": 1},
  {"name": "binary", "expression": "GROUP + suffix", "bare": 0, "wrapped": 1},
  {"name": "unary", "expression": "void GROUP", "bare": 0, "wrapped": 1},
  {"name": "update", "expression": "GROUP++", "bare": 1, "wrapped": 2},
  {"name": "assignment", "expression": "unrelated = GROUP", "bare": 0, "wrapped": 1},
  {"name": "arrow", "expression": "() => GROUP", "bare": 0, "wrapped": 1},
  {"name": "function", "expression": "function () { return GROUP; }", "bare": 0, "wrapped": 1},
  {"name": "class", "expression": "class { view = GROUP; }", "bare": 0, "wrapped": 1},
  {"name": "object", "expression": "{ group: GROUP }", "bare": 0, "wrapped": 1},
  {"name": "array", "expression": "[GROUP]", "bare": 0, "wrapped": 1},
  {"name": "sequence", "expression": "fallback, GROUP", "bare": 0, "wrapped": 1},
  {"name": "template", "expression": "`${GROUP}`", "bare": 0, "wrapped": 1},
  {"name": "tagged-template", "expression": "identity`${GROUP}`", "bare": 0, "wrapped": 1},
  {"name": "as", "expression": "GROUP as Mutable", "bare": 1, "wrapped": 2},
  {"name": "angle-assertion", "expression": "<Mutable>GROUP", "bare": 1, "wrapped": 2},
  {"name": "satisfies", "expression": "GROUP satisfies TYPE", "bare": 0, "wrapped": 1},
  {"name": "non-null", "expression": "GROUP!", "bare": 1, "wrapped": 1},
  {"name": "instantiation", "expression": "GROUP.method<Mutable>", "bare": 0, "wrapped": 1},
  {"name": "optional-member", "expression": "GROUP?.value", "bare": 1, "wrapped": 1},
  {"name": "optional-call", "expression": "GROUP?.read()", "bare": 0, "wrapped": 1},
  {"name": "import", "expression": "import(GROUP)", "bare": 0, "wrapped": 1},
] as const;

for (const [group, slot, type] of [
  ['autosave', 'autosave', 'AutosaveGroup'], ['boundary', 'boundary', 'BoundaryGroup'],
  ['children', 'children', 'ChildrenGroup'], ['input', 'inputState', 'InputGroup'],
  ['session', 'liveSession', 'SessionGroup'], ['skills', 'skills', 'SkillsGroup'],
  ['usage', 'usage', 'UsageGroup'], ['wait', 'waitIdentity', 'WaitGroup'],
]) {
  const cases = OWNER_EXPRESSION_SHAPES.flatMap(shape => [false, true].flatMap(wrapped => {
    const expression = shape.expression.replaceAll('GROUP', `state.${slot}`).replaceAll('TYPE', type!);
    const argument = wrapped ? `(${expression})` : expression;
    return [
      `Object.assign(${argument}, {});`,
      `Object.assign(${argument});`,
      `Object.assign?.(${argument});`,
      `Object.assign?.<Mutable>(${argument});`,
    ].map(call => ({
      code: `async function* probe() { ${call} }`,
      errors: wrapped ? shape.wrapped : shape.bare,
    }));
  }));
  ruleCases(activeRunWriteRules.find(rule => rule.name === `active-run-${group}-write-outside-owner`)!, {
    file: 'packages/cezar/src/workflows/run/example.ts',
    valid: cases.filter(test => test.errors === 0).map(test => test.code),
    invalid: cases.filter(test => test.errors > 0),
  });
}

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-session-write-outside-owner')!, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'Array.from(state.liveSession.pendingPermissions).push(permission);',
    'const copy = Array.from(state.liveSession.pendingPermissions); copy.push(permission);',
  ],
  invalid: [],
});

ruleCases(activeRunWriteRules.find(rule => rule.name === 'active-run-usage-write-outside-owner')!, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [
    'Object.assign?.(new Map(state.usage.cumulativeSessionCost));',
    'Object.assign?.<Mutable>(new Map(state.usage.cumulativeSessionCost));',
  ],
  invalid: [
    'Object.assign?.((new Map(state.usage.cumulativeSessionCost)));',
    'Object.assign?.<Mutable>((new Map(state.usage.cumulativeSessionCost)));',
  ],
});

// Object accessors, like object methods, cannot inherit a surrounding manager exemption.
ruleCases(activeRunMapWrite, {
  file: 'packages/cezar/src/workflows/run/example.ts',
  valid: [],
  invalid: [
    "class RunManager { activate() { return { active: new Map(), get value() { this.active.set('id', {}); return 1; } }; } }",
    "class RunManager { activate() { return { active: new Map(), set value(value) { this.active.set('id', value); } }; } }",
    "class RunManager { dropActive() { return { active: new Map(), get value() { this.active.delete('id'); return 1; } }; } }",
    "class RunManager { dropActive() { return { active: new Map(), set value(value) { this.active.delete(value); } }; } }",
  ],
});
