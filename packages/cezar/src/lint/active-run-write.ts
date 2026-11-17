import { child, children, nameOf, type AstContext, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';

/** Group ownership metadata for the cez/active-run-*-write-outside-owner rules (hearsay-tools/squawk#3774). */
interface OwnerGroup {
  owner: string;
  factory: string;
  slot?: string;
  types: string[];
  getters: string[];
  bindings?: string[];
  fields: string[];
}

const OWNER_GROUPS: Record<string, OwnerGroup> = {
  boundary: {
    owner: "turn-boundary.ts",
    factory: "createBoundaryGroup",
    types: ["BoundaryGroup", "DoneRequest", "NextStep", "DoneClose", "AckBoundary", "Nudge"],
    getters: ["boundary"],
    bindings: ["boundary", "nextStep", "doneClose", "parkAfterAck", "nudge"],
    fields: ["boundary", "waitWakeTurn", "pendingHumanAsk", "noWaitNudgeReplyTimer", "noWaitNudgeSawContent", "noWaitNudgeParked", "doneAtBoundary", "requestRefusedDone", "nextStep", "completedStepId", "doneClose", "parkAfterAck", "atTurnBoundary", "idleTimer", "idleClosed", "monitoringCapNoted", "autonomous", "nudge", "noWaitNudged", "incomingRequestRefused", "sentRequestRefused", "completionNudged", "completionNudgeAnswered", "heldForSubagents", "session", "summary", "label", "via", "monitoring", "humanGate", "nudgedLastTurn", "scheduleWakeup", "cause", "state"],
  },
  wait: {
    slot: "waitIdentity",
    owner: "wait-registry.ts",
    factory: "createWaitGroup",
    types: ["WaitGroup"],
    getters: ["waitIdentity"],
    bindings: ["waitIdentity", "ciTurnId"],
    fields: ["waitIdentity", "ciTurnId"],
  },
  autosave: {
    owner: "worktree-autosave.ts",
    factory: "createAutosaveGroup",
    types: ["AutosaveGroup"],
    getters: ["autosave", "autosaveTimer"],
    fields: ["autosave", "autosaveTimer"],
  },
  input: {
    slot: "inputState",
    owner: "input-delivery.ts",
    factory: "createInputGroup",
    types: ["InputGroup", "InputFlight", "DeliveryAttempt", "ReadonlySetView"],
    getters: ["inputState"],
    bindings: ["inputState", "agentInputFlight", "inputDelivery", "unreadInputIds", "consumedBeforeAck", "bundledInputIds", "turnOpenerIds", "retiredInFlight", "unreadRetried", "inputIds"],
    fields: ["inputState", "agentInputError", "agentInputFlight", "inputDelivery", "unreadInputIds", "consumedBeforeAck", "bundledInputIds", "turnOpenerIds", "retiredInFlight", "unreadInputTimer", "unreadRetried", "heldHumanInputTimer", "heldHumanInputSince", "heldHumanInputExpired", "openingAnswerAskSeq", "openingAgentInputId", "writingInput", "deliveryAttempt", "session", "inputIds", "outcome", "settled", "wakeReserved", "admittedWake", "mode", "consumption", "via", "length", "size"],
  },
  session: {
    slot: "liveSession",
    owner: "live-session-state.ts",
    factory: "createSessionGroup",
    types: ["SessionGroup", "ReadonlySetView"],
    getters: ["liveSession"],
    bindings: ["liveSession", "delegationSettings", "pendingPermissions", "accountBinding", "claudeLayout", "allowedTools", "bashAllowlist"],
    fields: ["liveSession", "delegationSettings", "revokeDelegation", "revokeCiTools", "ciGeneration", "cancelled", "finishRequested", "interrupt", "cwd", "session", "pendingPermissions", "agentSessionError", "currentStepId", "sessionEverOpened", "releaseRepoRoot", "runner", "model", "modelIdentity", "effort", "agentProfile", "accountBinding", "systemPrompt", "allowedTools", "bashAllowlist", "provider", "profileId", "homePath", "claudeLayout", "kind", "statePath", "length", "size"],
  },
  usage: {
    owner: "usage-accounting.ts",
    factory: "createUsageGroup",
    types: ["UsageGroup", "UsageInvocation", "ReadonlyMapView", "ReadonlySetView"],
    getters: ["cumulativeSessionCost", "usageInvocation", "startedTurns", "recordedTurns"],
    fields: ["usage", "cumulativeSessionCost", "usageInvocation", "observed", "epoch", "stepId", "startedTurns", "recordedTurns", "size"],
  },
  skills: {
    owner: "run-skills.ts",
    factory: "createSkillsGroup",
    types: ["SkillsGroup"],
    getters: ["catalog", "unavailableReason"],
    bindings: ["catalog", "query", "account", "unavailableReason"],
    fields: ["skills", "catalog", "query", "account", "unavailableReason", "id", "name", "description", "scope", "plugin", "path", "runner", "cwd", "accountHome", "length"],
  },
  children: {
    owner: "subagent-waits.ts",
    factory: "createChildrenGroup",
    types: ["ChildrenGroup", "ReadonlyMapView"],
    getters: ["backgroundChildren"],
    fields: ["children", "backgroundChildren", "session", "status", "size"],
  },
};

/** Literal string keys only: the former rules did not follow computed templates or expressions. */
function memberName(node: EsNode | undefined): string | undefined {
  if (node?.type !== 'MemberExpression') return undefined;
  const key = child(node, 'property');
  return node.computed === true ? literalString(key) : key?.type === 'Identifier' ? nameOf(key) : undefined;
}

/** ESTree uses Identifier for tree-sitter property_identifier too; those are not references. */
function referenceName(node: EsNode): string | undefined {
  if (node.type !== 'Identifier') return undefined;
  const parent = node.parent;
  if (parent?.type === 'MemberExpression' && parent.computed !== true && child(parent, 'property') === node) return undefined;
  if (parent && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && parent.computed !== true && child(parent, 'key') === node) return undefined;
  return nameOf(node);
}

function literalString(node: EsNode | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

const FUNCTION_SCOPES = new Set(['Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const BLOCK_SCOPES = new Set(['Program', 'BlockStatement']);
function nearest(node: EsNode, types: Set<string>): EsNode {
  let scope = node;
  while (scope.parent && !types.has(scope.type)) scope = scope.parent;
  return scope;
}

const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const OBJECT_WRITES = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
const REFLECT_WRITES = new Set(['defineProperty', 'set', 'setPrototypeOf', 'deleteProperty']);

/** The immutable slot installation is the original template's sole call exemption. */
function installsSlot(node: EsNode): boolean {
  const callee = child(node, 'callee');
  if (memberName(callee) !== 'defineProperty' || nameOf(callee && child(callee, 'object')) !== 'Object') return false;
  const descriptor = children(node, 'arguments')[2];
  if (descriptor?.type !== 'ObjectExpression') return false;
  const properties = children(descriptor, 'properties');
  if (properties.length !== 2) return false;
  if (!properties.every((property, index) => property.computed !== true &&
    nameOf(child(property, 'key')) === ['writable', 'configurable'][index] && child(property, 'value')?.value === false,
  )) return false;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'FunctionDeclaration' && nameOf(child(ancestor, 'id')) === 'createActiveRun') return true;
  }
  return false;
}

/** Oxlint's token methods are used only to recover parentheses ESTree omits. */
interface NodeTokens {
  readonly visitorKeys: Readonly<Record<string, readonly string[]>>;
  getTokenBefore(node: EsNode): EsNode | null;
  getTokenAfter(node: EsNode): EsNode | null;
}

function parenthesized(node: EsNode, tokens: NodeTokens): boolean {
  const before = tokens.getTokenBefore(node);
  const after = tokens.getTokenAfter(node);
  if (before?.value !== '(' || after?.value !== ')') return false;
  const argument = node.parent?.type === 'ChainExpression' ? node.parent : node;
  const parent = argument.parent;
  if (parent && ['CallExpression', 'NewExpression'].includes(parent.type) && children(parent, 'arguments')[0] === argument) {
    // A sole argument's call delimiters are not parentheses around the argument itself.
    const head = child(parent, 'typeArguments') ?? child(parent, 'typeParameters') ?? child(parent, 'callee');
    let opening = head && tokens.getTokenAfter(head);
    if (opening?.value === '?.') opening = tokens.getTokenAfter(opening);
    if (opening && (opening.range as number[])[0] === (before.range as number[])[0]) return false;
  }
  return true;
}

type ScopeIndex = Map<string, EsNode[]>;
interface ScopeFacts { types: Map<EsNode, ScopeIndex>; bindings: Map<EsNode, ScopeIndex>; patterns: Map<EsNode, EsNode[]>; imports: EsNode[] }

function addEntry(index: Map<EsNode, ScopeIndex>, node: EsNode, scopes: Set<string>, name: string | undefined, value: EsNode | undefined): void {
  if (!name || !value) return;
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!scopes.has(scope.type)) continue;
    let entries = index.get(scope);
    if (!entries) { entries = new Map(); index.set(scope, entries); }
    const list = entries.get(name);
    if (list) list.push(value);
    else entries.set(name, [value]);
  }
}

/**
 * Scope facts collected as oxlint walks the file, with no walk of our own: each function scope gets
 * the typed names of its descendants, each block scope its bindings and object-pattern declarators.
 * The owners decide at `Program:exit`, once every fact of the file is in.
 */
function factVisitors(facts: ScopeFacts): Visitors {
  return {
    TSTypeAnnotation(node) {
      const owner = node.parent;
      // Only an identifier has both a name and a type annotation.
      if ((owner?.type === 'Identifier' || owner?.type === 'PrivateIdentifier') && child(owner, 'typeAnnotation') === node) {
        addEntry(facts.types, owner, FUNCTION_SCOPES, nameOf(owner), node);
      }
    },
    VariableDeclarator(node) {
      const id = child(node, 'id');
      addEntry(facts.bindings, node, BLOCK_SCOPES, nameOf(id), child(node, 'init'));
      if (id?.type !== 'ObjectPattern') return;
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (!BLOCK_SCOPES.has(scope.type)) continue;
        const list = facts.patterns.get(scope);
        if (list) list.push(node);
        else facts.patterns.set(scope, [node]);
      }
    },
    ImportSpecifier(node) { facts.imports.push(node); },
  };
}

const NO_ENTRIES: ScopeIndex = new Map();

/** Structural facts shared by the eight owners, with no owner-dependent reference results. */
function syntaxIndex(tokens: NodeTokens) {
  const facts: ScopeFacts = { types: new Map(), bindings: new Map(), patterns: new Map(), imports: [] };
  const descendants = new Map<EsNode, EsNode[]>();
  const parentheses = new Map<EsNode, boolean>();
  function nodes(scope: EsNode): EsNode[] {
    const known = descendants.get(scope);
    if (known) return known;
    const result: EsNode[] = [];
    function visit(node: EsNode) {
      result.push(node);
      // Skip loc/range and other metadata; oxlint supplies the syntax child keys.
      for (const key of tokens.visitorKeys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) { for (const item of children(node, key)) visit(item); }
        else { const item = child(node, key); if (item) visit(item); }
      }
    }
    visit(scope);
    descendants.set(scope, result);
    return result;
  }
  function index(scope: EsNode, kind: 'type' | 'binding'): Map<string, EsNode[]> {
    return (kind === 'type' ? facts.types : facts.bindings).get(scope) ?? NO_ENTRIES;
  }
  /** The scope's variable declarators with an object pattern, in source order. */
  function patterns(scope: EsNode): EsNode[] {
    return facts.patterns.get(scope) ?? [];
  }
  function isParenthesized(node: EsNode): boolean {
    let result = parentheses.get(node);
    if (result === undefined) { result = parenthesized(node, tokens); parentheses.set(node, result); }
    return result;
  }
  return { nodes, index, patterns, isParenthesized, importSpecifiers: () => facts.imports, visitors: factVisitors(facts) };
}

/**
 * The file being linted and its shared facts. oxlint reuses one sourceCode object across files, so
 * only the Program identity marks a new file. The first owner to see a Program collects its facts
 * for all eight; the others read them.
 */
let shared: { program: EsNode; syntax: ReturnType<typeof syntaxIndex> } | undefined;
function programSyntax(program: EsNode, tokens: NodeTokens): { syntax: ReturnType<typeof syntaxIndex>; collects: boolean } {
  if (shared?.program === program) return { syntax: shared.syntax, collects: false };
  shared = { program, syntax: syntaxIndex(tokens) };
  return { syntax: shared.syntax, collects: true };
}

/**
 * Syntax-only reference predicates mirroring the old template. Typed names are searched in the
 * nearest function, bindings in the nearest block, including descendants of each scope. Bindings
 * follow only the template's one alias step; they are not a TypeScript binding or value resolver.
 */
function references(group: OwnerGroup, sourceCode: AstContext['sourceCode']) {
  const tokens = sourceCode as AstContext['sourceCode'] & NodeTokens;
  const groupTypes = new Set(group.types);
  const containerTypes = new Set(['ActiveRun']);
  let syntax: ReturnType<typeof syntaxIndex>;
  let imported = false;
  const memo = new Map<string, Map<EsNode, boolean>>();
  const nodes = (node: EsNode) => syntax.nodes(node);
  function cached(kind: string, node: EsNode | undefined, check: (node: EsNode) => boolean): boolean {
    if (!node) return false;
    let entries = memo.get(kind);
    if (!entries) { entries = new Map(); memo.set(kind, entries); }
    const known = entries.get(node);
    if (known !== undefined) return known;
    entries.set(node, false);
    const result = check(node);
    entries.set(node, result);
    return result;
  }
  function typed(node: EsNode, types: Set<string>): boolean {
    const name = referenceName(node);
    if (!name) return false;
    importTypes();
    const annotations = syntax.index(nearest(node, FUNCTION_SCOPES), 'type').get(name) ?? [];
    return annotations.some(annotation => nodes(annotation).some(part => types.has(nameOf(part) ?? '')));
  }
  function bound(node: EsNode, accepts: (value: EsNode | undefined) => boolean): boolean {
    const name = referenceName(node);
    if (!name) return false;
    const initializers = syntax.index(nearest(node, BLOCK_SCOPES), 'binding').get(name) ?? [];
    return initializers.some(accepts);
  }
  function lookup(node: EsNode): boolean {
    if (node.type === 'TSNonNullExpression') return lookup(child(node, 'expression')!);
    if (node.type !== 'CallExpression') return false;
    const callee = child(node, 'callee');
    if (nameOf(callee) === 'createActiveRun') return true;
    const receiver = callee && child(callee, 'object');
    return callee?.computed !== true && memberName(callee) === 'get' && receiver?.computed !== true && memberName(receiver) === 'active';
  }
  function containerBase(node: EsNode | undefined): boolean {
    return cached('containerBase', node, value => typed(value, containerTypes) || lookup(value) || bound(value, init =>
      init?.type === 'CallExpression' && nameOf(child(init, 'callee')) === 'createActiveRun',
    ));
  }
  function container(node: EsNode | undefined): boolean {
    return cached('container', node, value => containerBase(value) || bound(value, containerBase));
  }
  function getter(node: EsNode): boolean {
    const key = memberName(node);
    if (key === undefined) return false;
    if (group.getters.includes(key)) return true;
    const receiver = child(node, 'object');
    return key === group.slot && (['state', 'active'].includes(nameOf(receiver) ?? '') || container(receiver));
  }
  function expands(node: EsNode): boolean {
    if (['MemberExpression', 'TSNonNullExpression'].includes(node.type)) return true;
    if (node.type === 'ChainExpression') {
      const expression = child(node, 'expression');
      return expression !== undefined && expands(expression);
    }
    if (node.type === 'CallExpression') {
      const callee = child(node, 'callee');
      if (callee?.computed !== true && ['get', 'entries', 'values'].includes(memberName(callee) ?? '')) return true;
    }
    return syntax.isParenthesized(node);
  }
  function expandsFrom(node: EsNode, accepts: (value: EsNode) => boolean): boolean {
    if (!expands(node)) return false;
    const parts = nodes(node);
    return !parts.some(part => part.type === 'PrivateIdentifier') && parts.slice(1).some(accepts);
  }
  function base(node: EsNode | undefined): boolean {
    return cached('base', node, value => {
      if (typed(value, groupTypes) || getter(value) || expandsFrom(value, part => getter(part) || typed(part, groupTypes))) return true;
      if (value.type === 'NewExpression') return group.types.includes(nameOf(child(value, 'callee')) ?? '');
      return value.type === 'CallExpression' && nameOf(child(value, 'callee')) === group.factory;
    });
  }
  function destructured(node: EsNode): boolean {
    const name = referenceName(node);
    if (!name) return false;
    const keys = [group.slot!, ...(group.bindings ?? group.getters)];
    return syntax.patterns(nearest(node, BLOCK_SCOPES)).some(declaration => {
      const pattern = child(declaration, 'id')!;
      const matches = children(pattern, 'properties').some(property =>
        property.type === 'Property' && property.computed !== true && keys.includes(nameOf(child(property, 'key')) ?? '') && nameOf(child(property, 'value')) === name,
      );
      const init = child(declaration, 'init');
      return matches && (base(init) || container(init));
    });
  }
  function alias(node: EsNode): boolean {
    return cached('alias', node, value => bound(value, base) || destructured(value));
  }
  function reference(node: EsNode | undefined): boolean {
    return cached('reference', node, value => base(value) || alias(value) || expandsFrom(value, alias));
  }
  function importTypes() {
    if (imported) return;
    imported = true;
    for (const node of syntax.importSpecifiers()) {
      const imported = nameOf(child(node, 'imported'));
      const local = nameOf(child(node, 'local'));
      if (!imported || !local) continue;
      if (group.types.includes(imported)) groupTypes.add(local);
      if (imported === 'ActiveRun') containerTypes.add(local);
    }
  }
  /** Starts a file: true when this owner collects the file's facts for all eight. */
  function start(program: EsNode): boolean {
    const file = programSyntax(program, tokens);
    syntax = file.syntax;
    return file.collects;
  }
  return { container, getter, reference, start, nodes, facts: () => syntax.visitors };
}

function ownerRule(groupName: string, metadata: OwnerGroup): AstRule {
  const group = { ...metadata, slot: metadata.slot ?? groupName };
  const message = `Change ActiveRun ${group.slot} only through ${group.owner}. Groups and their live views expose no writable storage (hearsay-tools/cezarion#2520).`;
  return {
    name: `active-run-${groupName}-write-outside-owner`,
    description: message,
    applies: file => file.startsWith('packages/cezar/src/') && file.endsWith('.ts'),
    create(report, context) {
      const { container, getter, reference, start, nodes, facts } = references(group, context.sourceCode);
      function protectedMember(node: EsNode | undefined): boolean {
        if (node?.type !== 'MemberExpression') return false;
        if (node.computed === true && reference(child(node, 'object'))) return true;
        if (!group.fields.includes(memberName(node) ?? '')) return false;
        if (nodes(node).some(part => part.type === 'PrivateIdentifier')) return false;
        return getter(node) || reference(child(node, 'object'));
      }
      function write(node: EsNode, field: string) {
        if (protectedMember(child(node, field))) report(node, message);
      }
      function cast(node: EsNode) {
        const expression = child(node, 'expression');
        if (reference(expression)) { report(node, message); return; }
        if (expression?.type === 'ObjectExpression' && children(expression, 'properties').some(property =>
          property.type === 'SpreadElement' && reference(child(property, 'argument')),
        )) report(node, message);
      }
      function call(node: EsNode) {
        const callee = child(node, 'callee');
        if (callee?.type !== 'MemberExpression') return;
        const method = memberName(callee) ?? '';
        const receiver = child(callee, 'object');
        if (MUTATORS.has(method) && reference(receiver)) { report(node, message); return; }
        if (callee.computed === true) return;
        const object = nameOf(receiver);
        if (!(object === 'Object' && OBJECT_WRITES.has(method)) && !(object === 'Reflect' && REFLECT_WRITES.has(method))) return;
        const [target] = children(node, 'arguments');
        if ((reference(target) || container(target)) && !installsSlot(node)) report(node, message);
      }
      // A check needs every scope fact of the file, so candidates wait for Program:exit.
      let pending: (() => void)[] = [];
      let collect: Visitors = {};
      const later = (check: () => void) => { pending.push(check); };
      return {
        Program(node) {
          pending = [];
          collect = start(node) ? facts() : {};
        },
        TSTypeAnnotation: node => collect.TSTypeAnnotation?.(node),
        VariableDeclarator: node => collect.VariableDeclarator?.(node),
        ImportSpecifier: node => collect.ImportSpecifier?.(node),
        AssignmentExpression: node => later(() => write(node, 'left')),
        UpdateExpression: node => later(() => write(node, 'argument')),
        UnaryExpression: node => { if (node.operator === 'delete') later(() => write(node, 'argument')); },
        CallExpression: node => { if (child(node, 'callee')?.type === 'MemberExpression') later(() => call(node)); },
        TSAsExpression: node => later(() => cast(node)),
        TSTypeAssertion(node) {
          const expression = child(node, 'expression');
          if (expression) later(() => { if (nodes(expression).some(reference)) report(node, message); });
        },
        PropertyDefinition(node) {
          if (child(node, 'key')?.type === 'PrivateIdentifier') return;
          const owner = node.parent?.parent;
          if (owner?.type === 'ClassDeclaration' && group.types.includes(nameOf(child(owner, 'id')) ?? '')) report(node, message);
        },
        'Program:exit'() {
          const checks = pending;
          pending = [];
          for (const check of checks) check();
        },
      };
    },
  };
}

export const activeRunWriteRules: AstRule[] = Object.entries(OWNER_GROUPS).map(([name, group]) => ownerRule(name, group));
