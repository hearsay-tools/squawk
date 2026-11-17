import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { OWNER_POLICIES } from './owner-policies.ts';
import { fragment, inside, key, member, objectProperty, ownerRule, unwrap, unwrapAccess, walk } from './owner-rule.ts';

const equality = /^(===|!==|==|!=)$/;
const literalString = (node: EsNode | undefined) => node?.type === 'Literal' ? stringOf(node) : undefined;
const ASK_EVENT = 'ask.requested';
export const askRequestedRead = ownerRule(OWNER_POLICIES['ask-requested-read-outside-projection']!, report => ({
  BinaryExpression(node) {
    if (equality.test(String(node.operator)) && [child(node, 'left'), child(node, 'right')].some(part => literalString(part) === ASK_EVENT)) report(node);
  },
  SwitchCase(node) { if (literalString(child(node, 'test')) === ASK_EVENT) report(node); },
}));
export const jsonValid = ownerRule(OWNER_POLICIES['json-valid-outside-guard']!, report => {
  const check = (node: EsNode) => { if (/json_valid\s*\(/.test(fragment(node) ?? '')) report(node); };
  return { Literal: check, TemplateElement: check };
});

/** Report each leaf syntax occurrence once; ESTree shares shorthand/import identifier slots. */
const RETIRED_NAME = ['run', 'Internals'].join('');
const RETIRED_MODULE = ['run-internals', 'testkit'].join('.');
export const retiredInternals = ownerRule(OWNER_POLICIES['run-internals']!, report => {
  const seen = new Set<string>();
  const check = (node: EsNode) => {
    const text = nameOf(node) ?? fragment(node);
    if (text !== RETIRED_NAME && !(fragment(node) ?? '').includes(RETIRED_MODULE)) return;
    const position = `${node.start}:${node.end}`;
    if (seen.has(position)) return;
    seen.add(position);
    report(node);
  };
  return { Identifier: check, PrivateIdentifier: check, Literal: check, TemplateElement: check };
});

export const runSearchFields = ownerRule(OWNER_POLICIES['run-search-field-list-outside-contract']!, report => ({
  ArrayExpression(node) {
    let branch = false;
    let workflow = false;
    walk(node, part => {
      if (member(part) === 'branch') branch = true;
      if (member(part) === 'workflow') workflow = true;
    });
    if (branch && workflow) report(node);
  },
}));

export const RUNNER_CLASSES = ['ClaudeCliRunner', 'CodexAppServerRunner', 'OmpRunner', 'OpencodeServerRunner', 'PiRunner'];
export function concreteRunnerModule(specifier: string): boolean {
  return /(^|\/)core\/[a-z0-9-]+-runner(\.ts|\.js)?$/.test(specifier) && !/\/agent-runner(\.ts|\.js)?$/.test(specifier);
}
const runnerSource = (node: EsNode | undefined) => concreteRunnerModule(literalString(node) ?? '');
function allowedImportType(node: EsNode): boolean {
  return inside(node, at => at.type === 'TSTypeAliasDeclaration' || at.type === 'TSTypeAnnotation');
}
export const runnerClass = ownerRule(OWNER_POLICIES['runner-class-outside-factory']!, report => {
  const staticLoad = (node: EsNode) => {
    if (node.importKind !== 'type' && node.exportKind !== 'type' && runnerSource(child(node, 'source'))) report(node);
  };
  return {
    NewExpression(node) {
      const fn = child(node, 'callee');
      if (RUNNER_CLASSES.includes(nameOf(fn) ?? member(fn) ?? '')) report(node);
    },
    ImportDeclaration: staticLoad,
    ExportNamedDeclaration: staticLoad,
    ExportAllDeclaration: staticLoad,
    ImportExpression(node) { if (runnerSource(child(node, 'source')) && !allowedImportType(node)) report(node); },
    TSImportType(node) {
      const source = child(node, 'source');
      if (runnerSource(source) && !allowedImportType(node)) report(node);
    },
    CallExpression(node) {
      if (nameOf(child(node, 'callee')) === 'require' && children(node, 'arguments').some(runnerSource) && !allowedImportType(node)) report(node);
    },
  };
});

/** Variable bindings are file-scoped in this syntax guard, including nested declarations. */
export const serverValidator = ownerRule(OWNER_POLICIES['server-declared-validator-schema']!, report => {
  const declarations = new Set<string>();
  return {
    Program(node) {
      walk(node, part => {
        if (part.type !== 'VariableDeclarator') return;
        const name = nameOf(child(part, 'id'));
        if (name) declarations.add(name);
      });
    },
    CallExpression(node) {
      if (!/^(json|param|query)ZodValidator$/.test(nameOf(child(node, 'callee')) ?? '')) return;
      const first = children(node, 'arguments')[0];
      if (!first) return;
      const binding = first.type === 'ArrowFunctionExpression' ? nameOf(child(first, 'body')) : nameOf(first);
      let base = first;
      while (base.type === 'CallExpression' || base.type === 'MemberExpression') {
        const next = child(base, base.type === 'CallExpression' ? 'callee' : 'object');
        if (!next) break;
        base = next;
      }
      const inline = first.type === 'CallExpression' && nameOf(base) === 'z';
      if (inline || (binding && declarations.has(binding))) report(first);
    },
  };
});

export const WAIT_KIND_LITERALS = ['pr', 'timer', 'process', 'human', 'worker', 'peer', 'subagent', 'ci'];
function waitLiteral(node: EsNode | undefined): boolean {
  return WAIT_KIND_LITERALS.includes(literalString(unwrap(node)) ?? '');
}
function kindRef(node: EsNode | undefined): boolean {
  node = unwrapAccess(node);
  return nameOf(node) === 'kind' || member(node) === 'kind';
}
export const waitKindLiteral = ownerRule(OWNER_POLICIES['wait-kind-literal-outside-engine']!, report => ({
  BinaryExpression(node) {
    if (!equality.test(String(node.operator))) return;
    const left = child(node, 'left');
    const right = child(node, 'right');
    if ((kindRef(left) && waitLiteral(right)) || (kindRef(right) && waitLiteral(left))) report(node);
  },
  SwitchCase(node) { if (waitLiteral(child(node, 'test'))) report(node); },
  Property(node) { if (objectProperty(node) && key(node) === 'kind' && waitLiteral(child(node, 'value'))) report(node); },
}));

export const READER_OWNER_RULES: AstRule[] = [askRequestedRead, jsonValid, retiredInternals, runSearchFields, runnerClass, serverValidator, waitKindLiteral];
