import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { Resolver, type Family } from './launch-read/resolve.ts';
import { annotation, functionTypes, keyOf, parameterOwner, unwrap, walk } from './launch-read/syntax.ts';

const rawFields = new Set('workflow workflowDef input runner defaultRunner systemPrompt model effort agentProfile profileId account grants prompt task images taskImages stackedImages queuedMessages continuationMessage sessionTransport skill catalog disabledTeamSkills worktreeSetup'.split(' '));
const fieldGroups: [Family, Set<string>][] = [
  ['source', rawFields],
  ['input', new Set('worktree autonomous archiveWhenDone autoMergePr notify automation automationTrigger persistedImages persistedAttachments'.split(' '))],
  ['workflow', new Set(['steps', 'name'])],
  ['step', new Set(['allowedTools', 'bashAllowlist'])],
  ['config', new Set(['baseBranch', 'worktreeSetup', 'defaultRunner', 'systemPrompt'])],
];
const selectors = new Set('loadWorkflows stepToolGrant loadConfig agentModelsLocked readAgentModelProvider normalizeModelForBackend workerIdentity workerStepIdentity ownedWorkflow continuationDefStep resolveProfileEnvForRoot boundWorkerAccountEnv captureWorkerAccount discoverSkills filterDisabledTeamSkills filterDisabledTeamSources readDisabledTeamSkills readDisabledSkillsReposSync readProjectUiState readProjectUiStateSync getTeamSkillsCached resolveAttachmentPath readPersistedAttachments accountHeldFor executionAccount queuedRecoveryInput'.split(' '));
const modulePattern = /(?:^|\/)(?:config|skills|skills-remote|agent-model-policy|models|agent-profiles|execution-identity|run-scheduling|execution-account|ui-state|model-identity|attachment-path|load|types)\.(?:ts|js)$/;
const message = 'Production-source read rule; test and testkit readers observe ownership and error behavior outside production selection. Use narrow phase operations in launch-read-resolver.ts at the original read point. The launch-read-outside-resolver rule family does not follow arbitrary aliases of context.store.getRun() results. The launch-read-outside-resolver rule family does not infer launch-source types through nested structural member paths with two or more property accesses before the launch field or copy operation (class fix: hearsay-tools/cezarion#2744). See packages/cezar/src/workflows/launch-read-resolver.types.testkit.ts for compiled handle and lifecycle-store alias controls (owner decision: option A).';

function lifecycle(node: EsNode): boolean {
  if (node.computed) return false;
  const field = keyOf(node);
  let parent = node.parent;
  if (parent?.type === 'ChainExpression') parent = parent.parent;
  if (parent?.type === 'MemberExpression') {
    const safe: Record<string, string[]> = { worktreeSetup: ['status'], continuationMessage: ['origin', 'agentInputId'], queuedMessages: ['length'] };
    if (safe[field ?? '']?.includes(keyOf(parent) ?? '')) return true;
  }
  if (field === 'worktreeSetup' && parent?.type === 'BinaryExpression' && parent.operator === '===' && nameOf(child(parent, 'right')) === 'undefined') return true;
  return field === 'workflowDef' && parent?.type === 'UnaryExpression' && parent.operator === '!';
}
function fieldRead(node: EsNode, resolver: Resolver): boolean {
  if (lifecycle(node)) return false;
  const receiver = child(node, 'object');
  const field = keyOf(node);
  if (!node.computed && field === 'catalog' && receiver?.type === 'MemberExpression' && keyOf(receiver) === 'skills') return true;
  return fieldGroups.some(([family, fields]) => (!field || fields.has(field)) && (resolver.receiver(receiver, family) || (family === 'source' && resolver.store(receiver))));
}
function patternRead(pattern: EsNode, receiver: EsNode | undefined, resolver: Resolver): boolean {
  let matched = false;
  walk(pattern, node => {
    if (node.type === 'RestElement' && resolver.capture(receiver)) matched = true;
    if (node.type !== 'Property') return;
    const key = keyOf(node);
    if (fieldGroups.some(([family, fields]) => (!key || fields.has(key)) && (resolver.receiver(receiver, family) || (family === 'source' && resolver.store(receiver))))) matched = true;
  });
  return matched;
}
function typedPattern(pattern: EsNode, resolver: Resolver): boolean {
  const type = annotation(pattern);
  if (!type) return false;
  let matched = false;
  walk(pattern, node => {
    if (node.type === 'RestElement' && resolver.type(type, 'source')) matched = true;
    if (node.type !== 'Property') return;
    const key = keyOf(node);
    if (fieldGroups.some(([family, fields]) => (!key || fields.has(key)) && resolver.type(type, family))) matched = true;
  });
  return matched;
}
function copyTarget(node: EsNode | undefined): boolean {
  const callee = unwrap(node);
  if (!callee) return false;
  if (nameOf(callee) === 'structuredClone') return true;
  if (callee.type !== 'MemberExpression') return false;
  const owner = nameOf(child(callee, 'object'));
  const names = owner === 'Object' ? ['assign', 'entries', 'keys', 'values'] : owner === 'JSON' ? ['stringify', 'parse'] : [];
  return names.includes(keyOf(callee) ?? '');
}
function selectorCall(node: EsNode, resolver: Resolver): boolean {
  const callee = unwrap(child(node, 'callee'))!;
  const name = nameOf(callee);
  if (name && selectors.has(name) && !resolver.declared(callee, name)) return true;
  return callee.type === 'MemberExpression' && !callee.computed && nameOf(child(callee, 'object')) === 'source' && !resolver.declared(callee, 'source') && selectors.has(keyOf(callee) ?? '');
}
function ownedModule(node: EsNode | undefined): boolean { return modulePattern.test(stringOf(unwrap(node)) ?? ''); }
function declarationRead(node: EsNode): boolean {
  if (node.importKind === 'type' || node.exportKind === 'type') return false;
  if (node.type === 'ExportAllDeclaration') return ownedModule(child(node, 'source'));
  if (node.type === 'TSImportEqualsDeclaration') return ownedModule(child(child(node, 'moduleReference')!, 'expression'));
  return children(node, 'specifiers').some(specifier => {
    if (specifier.importKind === 'type' || specifier.exportKind === 'type') return false;
    if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type)) return ownedModule(child(node, 'source'));
    return selectors.has(nameOf(child(specifier, specifier.type === 'ImportSpecifier' ? 'imported' : 'local')) ?? '');
  });
}
function variableRead(node: EsNode, resolver: Resolver): boolean {
  const pattern = child(node, 'id')!;
  const init = child(node, 'init');
  if (pattern.type === 'Identifier') return resolver.capture(init);
  return pattern.type === 'ObjectPattern' && (typedPattern(pattern, resolver) || patternRead(pattern, init, resolver));
}
function capturedReturn(node: EsNode): boolean {
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (owner.type === 'MethodDefinition') return true;
    if (owner.type === 'Property' && (owner.method === true || owner.kind === 'get' || owner.kind === 'set')) return true;
  }
  return false;
}

/** The eleven former launch-read guards share one AST and binding index (hearsay-tools/squawk#3774). */
export const launchReadOutsideResolver: AstRule = {
  name: 'launch-read-outside-resolver',
  description: message,
  applies: file => (file === 'packages/cezar/src/workflows/run.ts' || /^packages\/cezar\/src\/workflows\/run\/.*\.ts$/.test(file)) && !file.endsWith('.test.ts') && !file.endsWith('.testkit.ts') && file !== 'packages/cezar/src/workflows/run/launch-read-resolver.ts',
  create(report) {
    let resolver: Resolver;
    const check = (node: EsNode, matched: boolean) => { if (matched) report(node, message); };
    return {
      Program(node) { resolver = new Resolver(node); },
      MemberExpression(node) { check(node, fieldRead(node, resolver)); },
      VariableDeclarator(node) { check(node, variableRead(node, resolver)); },
      AssignmentExpression(node) {
        const left = child(node, 'left')!;
        check(node, resolver.capture(child(node, 'right')) || (left.type === 'ObjectPattern' && patternRead(left, child(node, 'right'), resolver)));
      },
      ObjectPattern(node) { if (functionTypes.has(parameterOwner(node)?.type ?? '')) check(node, typedPattern(node, resolver)); },
      SpreadElement(node) { check(node, resolver.capture(child(node, 'argument'), true)); },
      CallExpression(node) {
        const callee = unwrap(child(node, 'callee'));
        const args = children(node, 'arguments');
        check(node, selectorCall(node, resolver) || (nameOf(callee) === 'require' && args.some(ownedModule)) || (copyTarget(callee) && args.some(arg => resolver.capture(arg, true))));
      },
      ImportExpression(node) { check(node, ownedModule(child(node, 'source'))); },
      ImportDeclaration(node) { check(node, declarationRead(node)); },
      ExportNamedDeclaration(node) { check(node, declarationRead(node)); },
      ExportAllDeclaration(node) { check(node, declarationRead(node)); },
      TSImportEqualsDeclaration(node) { check(node, declarationRead(node)); },
      TSTypeAliasDeclaration(node) { check(node, resolver.type(child(node, 'typeAnnotation'), 'source', false, false)); },
      Property(node) { if (node.parent?.type === 'ObjectExpression') check(node, node.shorthand === true ? resolver.receiver(child(node, 'value'), 'capture') : resolver.capture(child(node, 'value'))); },
      ReturnStatement(node) { check(node, capturedReturn(node) && resolver.capture(child(node, 'argument'))); },
      ArrowFunctionExpression(node) { check(node, resolver.capture(child(node, 'body'))); },
    };
  },
};
