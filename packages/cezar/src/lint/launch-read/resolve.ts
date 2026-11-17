import { child, children, nameOf, type EsNode } from '../ast-rule.ts';
import { Bindings } from './bindings.ts';
import { annotation, assertedTypes, bindingTarget, functionTypes, keyOf, unwrap } from './syntax.ts';

export type Family = 'source' | 'capture' | 'input' | 'workflow' | 'step' | 'config';
const roots: Record<Family, Set<string>> = {
  source: new Set('StartRunInput PendingJob PendingContinuation WorkflowDef WorkflowStepDef WorkerStepIdentity RunRecord StepState CezConfig LaunchConfig LaunchSource ExecutionLaunch Execution'.split(' ')),
  capture: new Set('StartRunInput PendingJob PendingContinuation WorkflowDef WorkflowStepDef WorkerStepIdentity CezConfig LaunchConfig LaunchSource ExecutionLaunch Execution'.split(' ')),
  input: new Set(['StartRunInput']), workflow: new Set(['WorkflowDef']),
  step: new Set(['WorkflowStepDef', 'WorkerStepIdentity']), config: new Set(['CezConfig', 'LaunchConfig']),
};
const names: Record<Family, Set<string>> = {
  source: new Set('job input effectiveInput continuation workflow step toolsStep stepIdentity record run config checkpoint owningStep sessionStep execution'.split(' ')),
  capture: new Set('job input effectiveInput continuation workflow step toolsStep stepIdentity config configHandle launch execution'.split(' ')),
  input: new Set(['input', 'effectiveInput']), workflow: new Set(['workflow']),
  step: new Set(['step', 'toolsStep', 'stepIdentity']), config: new Set(['config', 'configHandle']),
};
const views = new Set(['Pick', 'Omit', 'Partial', 'Required', 'NonNullable']);

export class Resolver {
  private readonly bindings: Bindings;
  constructor(program: EsNode) { this.bindings = new Bindings(program); }

  declared(node: EsNode, name: string): boolean { return !!this.bindings.lookup(node, name, 'values'); }

  type(node: EsNode | undefined, family: Family, aliases = true, view = true): boolean {
    if (!node) return false;
    if (node.type === 'TSTypeAnnotation' || node.type === 'TSParenthesizedType') return this.type(child(node, 'typeAnnotation'), family, aliases, view);
    if (node.type === 'TSUnionType') return children(node, 'types').some(type => this.type(type, family, aliases, view));
    if (node.type === 'TSImportType') return roots[family].has(nameOf(child(node, 'qualifier')) ?? '');
    if (node.type !== 'TSTypeReference') return false;
    const name = nameOf(child(node, 'typeName'));
    const args = child(node, 'typeArguments') ?? child(node, 'typeParameters');
    if (name === 'Readonly' || (view && views.has(name ?? ''))) return children(args ?? node, 'params').some(type => this.type(type, family, aliases, view));
    if (!name) return false;
    const declarations = this.bindings.lookup(node, name, 'types');
    if (!declarations) return roots[family].has(name);
    return declarations.some(declaration => this.typeDeclaration(declaration, family, aliases, view));
  }

  private typeDeclaration(node: EsNode, family: Family, aliases: boolean, view: boolean): boolean {
    if (node.type === 'ImportSpecifier') return roots[family].has(nameOf(child(node, 'imported')) ?? '');
    return aliases && node.type === 'TSTypeAliasDeclaration' && this.type(child(node, 'typeAnnotation'), family, false, view);
  }

  asserted(node: EsNode | undefined, family: Family): boolean {
    return assertedTypes(node).some(type => this.type(type, family));
  }

  receiver(node: EsNode | undefined, family: Family): boolean {
    if (!node) return false;
    if (this.asserted(node, family)) return true;
    const value = unwrap(node)!;
    const name = nameOf(value);
    if (name) {
      const declarations = this.bindings.lookup(value, name, 'values');
      if (!declarations) return names[family].has(name);
      return declarations.some(declaration => this.bindingType(declaration, family));
    }
    return value.type === 'MemberExpression' && this.member(value, family);
  }

  private bindingType(node: EsNode, family: Family): boolean {
    const pattern = node.type === 'VariableDeclarator' ? child(node, 'id') : node;
    return this.type(annotation(pattern), family) || (node.type === 'VariableDeclarator' && this.asserted(child(node, 'init'), family));
  }

  private propertyType(node: EsNode | undefined, key: string, family: Family, aliases = true): boolean {
    if (!node) return false;
    if (['TSTypeAnnotation', 'TSParenthesizedType'].includes(node.type)) return this.propertyType(child(node, 'typeAnnotation'), key, family, aliases);
    if (node.type === 'TSUnionType') return children(node, 'types').some(type => this.propertyType(type, key, family, aliases));
    if (node.type === 'TSTypeReference') return this.propertyReference(node, key, family, aliases);
    const members = [...children(node, 'members'), ...children(node, 'body')];
    return members.some(member => keyOf(member) === key && this.type(annotation(member), family));
  }

  private propertyReference(node: EsNode, key: string, family: Family, aliases: boolean): boolean {
    const name = nameOf(child(node, 'typeName'));
    if (name === 'Readonly') return children(child(node, 'typeArguments') ?? child(node, 'typeParameters') ?? node, 'params').some(type => this.propertyType(type, key, family, aliases));
    if (!name || !aliases) return false;
    return (this.bindings.lookup(node, name, 'types') ?? []).some(declaration => {
      const body = child(declaration, declaration.type === 'TSInterfaceDeclaration' ? 'body' : 'typeAnnotation');
      return this.propertyType(body, key, family, false);
    });
  }

  private member(node: EsNode, family: Family): boolean {
    const key = keyOf(node);
    if (!key) return false;
    const holder = child(node, 'object');
    if (assertedTypes(holder).some(type => this.propertyType(type, key, family))) return true;
    const value = unwrap(holder)!;
    if (value.type === 'ThisExpression') return this.thisProperty(value, key, family);
    const name = nameOf(value);
    if (!name) return false; // Preserve the documented limit: no nested structural paths.
    return (this.bindings.lookup(value, name, 'values') ?? []).some(declaration => {
      const pattern = declaration.type === 'VariableDeclarator' ? child(declaration, 'id') : declaration;
      return this.propertyType(annotation(pattern), key, family);
    });
  }

  private thisProperty(node: EsNode, key: string, family: Family): boolean {
    let edge = node;
    let computedClassKey = false;
    for (let owner = node.parent; owner; edge = owner, owner = owner.parent) {
      if (owner.type === 'MethodDefinition' && owner.computed && child(owner, 'key') === edge) computedClassKey = true;
      if (owner.type === 'ClassBody') {
        if (computedClassKey) { computedClassKey = false; continue; }
        return children(owner, 'body').some(member => this.classProperty(member, key, family));
      }
      if (functionTypes.has(owner.type) && owner.type !== 'ArrowFunctionExpression' && owner.parent?.type !== 'MethodDefinition') return false;
    }
    return false;
  }

  private classProperty(node: EsNode, key: string, family: Family): boolean {
    if (keyOf(node) === key && this.type(annotation(node), family)) return true;
    if (node.type !== 'MethodDefinition' || node.kind !== 'constructor') return false;
    return children(child(node, 'value')!, 'params').some(param => param.type === 'TSParameterProperty' && nameOf(bindingTarget(param)) === key && this.type(annotation(child(param, 'parameter')), family));
  }

  factory(node: EsNode | undefined): boolean {
    const value = unwrap(node);
    if (!value) return false;
    if (value.type === 'AwaitExpression') return this.factory(child(value, 'argument'));
    if (this.asserted(node, 'capture')) return true;
    if (value.type !== 'CallExpression') return false;
    const callee = unwrap(child(value, 'callee'))!;
    if (nameOf(callee) === 'bindLaunchSource') return true;
    return callee.type === 'MemberExpression' && ['atTaskHead', 'atContinue'].includes(nameOf(child(callee, 'object')) ?? '') && ['config', 'executionInput', 'jobInput'].includes(keyOf(callee) ?? '');
  }

  capture(node: EsNode | undefined, copy = false): boolean {
    if (!node) return false;
    const value = unwrap(node)!;
    if (copy && this.factory(node)) return true;
    // Direct assertions are copy sources, but ordinary capture expressions unwrap them.
    if (unwrap(node) !== node) return this.capture(child(node, 'expression'), copy);
    if (this.receiver(node, 'capture')) return true;
    const name = nameOf(value);
    if (name && (this.bindings.lookup(value, name, 'values') ?? []).some(declaration => declaration.type === 'VariableDeclarator' && this.factory(child(declaration, 'init')))) return true;
    return value.type === 'MemberExpression' && keyOf(value) === 'config' && this.receiver(child(value, 'object'), 'capture');
  }

  store(node: EsNode | undefined): boolean {
    const value = unwrap(node);
    if (!value) return false;
    if (this.getRun(value)) return true;
    const name = nameOf(value);
    return !!name && (this.bindings.lookup(value, name, 'values') ?? []).some(declaration => this.getRun(child(declaration, 'init')));
  }
  private getRun(node: EsNode | undefined): boolean {
    return node?.type === 'CallExpression' && keyOf(child(node, 'callee')!) === 'getRun';
  }
}
