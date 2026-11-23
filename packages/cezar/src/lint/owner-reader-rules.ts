import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { OWNER_POLICIES } from './owner-policies.ts';
import { fragment, inside, key, member, objectProperty, ownerRule, unwrap, unwrapAccess, walk } from './owner-rule.ts';
import { visit } from './babel-walk.ts';
import { repoRoot } from './source-rule.ts';
import { BUILT_IN_WAIT_KINDS, LEGACY_WAIT_KINDS } from '../workflows/wait-kind-ids.ts';

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

export function concreteRunnerModule(specifier: string): boolean {
  return /(^|\/)(?:core|runners\/[a-z0-9-]+)\/[a-z0-9-]+-runner(\.ts|\.js)?$/.test(specifier) && !/\/agent-runner(\.ts|\.js)?$/.test(specifier);
}
/** Whether an `implements` entry names `AgentRunner` itself, or `<namespace>.AgentRunner` from a
 *  namespace type import. A type argument such as `Provider<AgentRunner>` does not count. */
function namesAgentRunner(entry: Node): boolean {
  if (entry.type !== 'TSClassImplements') return false;
  const name = entry.expression;
  if (name.type === 'Identifier') return name.name === 'AgentRunner';
  return name.type === 'MemberExpression' && !name.computed && name.property.type === 'Identifier' && name.property.name === 'AgentRunner';
}
/** The names of the classes `source` (TypeScript) declares with `AgentRunner` among their top-level
 *  `implements` entries, with or without a base class: `class A extends Base implements Other, AgentRunner`.
 *  An anonymous class reads as `default`. */
export function runnerClassNames(source: string): string[] {
  const names: string[] = [];
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program, node => {
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && (node.implements ?? []).some(namesAgentRunner)) names.push(node.id?.name ?? 'default');
  });
  return names;
}
/** The classes that implement `AgentRunner` in the runner modules of the runner folders under
 *  `runners` (`runners/<id>/<name>-runner.ts`), so a new runner folder needs no edit here. A runner
 *  module that declares no such class throws: the rule would miss its class. */
export function runnerFolderClasses(runners = join(repoRoot, 'packages/cezar/src/runners')): string[] {
  return readdirSync(runners, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(folder => readdirSync(join(runners, folder.name)).filter(file => concreteRunnerModule(`runners/${folder.name}/${file}`))
      .flatMap(file => {
        const names = runnerClassNames(readFileSync(join(runners, folder.name, file), 'utf8'));
        if (names.length === 0) throw new Error(`runners/${folder.name}/${file} is a runner module, but no class in it implements AgentRunner.`);
        return names;
      }));
}
export const RUNNER_CLASSES: readonly string[] = runnerFolderClasses();
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

export const WAIT_KIND_LITERALS: readonly string[] = [...BUILT_IN_WAIT_KINDS, ...LEGACY_WAIT_KINDS];
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
