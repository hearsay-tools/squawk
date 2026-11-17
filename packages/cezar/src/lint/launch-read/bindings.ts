import { child, children, nameOf, type EsNode } from '../ast-rule.ts';
import { bindingNames, functionTypes, nodes } from './syntax.ts';

interface Scope {
  parent: Scope | undefined;
  node: EsNode;
  values: Map<string, EsNode[]>;
  types: Map<string, EsNode[]>;
}
const lexical = new Set(['Program', 'BlockStatement', 'ClassBody', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'SwitchStatement', 'TSModuleBlock', 'TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'ClassDeclaration', 'ClassExpression']);

/** Index declarations before checking reads, including hoisted var and nearer type shadows. */
export class Bindings {
  private readonly scopes = new WeakMap<EsNode, Scope>();
  constructor(program: EsNode) { this.index(program); }

  lookup(node: EsNode, name: string, space: 'values' | 'types'): EsNode[] | undefined {
    for (let scope = this.scopes.get(node); scope; scope = scope.parent) {
      const found = scope[space].get(name);
      if (found) return found;
    }
    return undefined;
  }

  private add(scope: Scope, space: 'values' | 'types', name: string | undefined, node: EsNode): void {
    if (name) scope[space].set(name, [...scope[space].get(name) ?? [], node]);
  }

  private bind(scope: Scope, pattern: EsNode | undefined, node: EsNode): void {
    if (pattern) for (const name of bindingNames(pattern)) this.add(scope, 'values', name, node);
  }

  private declarations(node: EsNode, scope: Scope, outer: Scope): void {
    const id = child(node, 'id');
    if (['FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(node.type)) this.add(outer, 'values', nameOf(id), node);
    if (['ClassDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(node.type)) this.add(outer, 'types', nameOf(id), node);
    if (['FunctionExpression', 'ClassExpression'].includes(node.type)) this.add(scope, 'values', nameOf(id), node);
    if (node.type === 'ClassExpression') this.add(scope, 'types', nameOf(id), node);
    if (functionTypes.has(node.type)) for (const param of children(node, 'params')) this.bind(scope, param, param);
    if (node.type === 'CatchClause') this.bind(scope, child(node, 'param'), node);
    if (node.type === 'VariableDeclarator') this.variable(node, scope);
    if (node.type.startsWith('Import') && node.type.endsWith('Specifier')) {
      this.add(scope, 'values', nameOf(child(node, 'local')), node);
      this.add(scope, 'types', nameOf(child(node, 'local')), node);
    }
    if (node.type === 'TSImportEqualsDeclaration') this.add(scope, 'values', nameOf(id), node);
    for (const param of children(child(node, 'typeParameters') ?? node, 'params')) {
      if (param.type === 'TSTypeParameter') this.add(scope, 'types', nameOf(child(param, 'name')) ?? (typeof param.name === 'string' ? param.name : undefined), param);
    }
  }

  private variable(node: EsNode, scope: Scope): void {
    let target = scope;
    if (node.parent?.kind === 'var') {
      while (target.parent && target.node.type !== 'Program' && !functionTypes.has(target.node.type)) target = target.parent;
    }
    this.bind(target, child(node, 'id'), node);
  }

  private index(node: EsNode, parent?: Scope): void {
    const owns = lexical.has(node.type) || functionTypes.has(node.type);
    const scope = owns || !parent ? { node, parent, values: new Map(), types: new Map() } : parent;
    this.scopes.set(node, scope);
    this.declarations(node, scope, parent ?? scope);
    for (const next of nodes(node)) this.index(next, scope);
  }
}
