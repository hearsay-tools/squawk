import type { Node } from '@babel/types';
import { isPath, type Bound } from './unit-wait-deadlines.ts';
import { boundApart, declaredHere, definition, isNumber, namedNumbers, ownNames, rootsOf, valuesOf, type DeadlineEvaluation, type Read, type Use, type View } from './unit-wait-values.ts';
import { serverClock, serverNumber } from './server-wait-ast-values.ts';
import { walk } from './unit-wait-discipline.ts';

const loopNames = new WeakMap<Node, Set<string>>();

/** The server also treats scalar for-header declarations as same-file bindings. */
function headerNames(root: Node): Set<string> {
  const cached = loopNames.get(root);
  if (cached) return cached;
  const names = new Set<string>();
  walk(root, [], node => {
    const declaration = node.type === 'ForStatement' ? node.init : node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? node.left : undefined;
    if (declaration?.type !== 'VariableDeclaration') return;
    for (const entry of declaration.declarations) if (entry.id.type === 'Identifier') names.add(entry.id.name);
  });
  loopNames.set(root, names);
  return names;
}

function serverApart(view: View, name: string): boolean {
  const root = view.above[0];
  return boundApart(root, name) || (root !== undefined && headerNames(root).has(name));
}

function outside(node: Node, view: View, use: Use): boolean {
  return rootsOf(node).some(name => !ownNames.has(name) && !declaredHere(view, use, name) && !serverApart(view, name));
}

/** An unknown same-file value invalidates a name, even beside another known value. */
function minimum(bounds: readonly Bound[]): Bound {
  if (bounds.includes(undefined)) return undefined;
  const known = bounds.filter(isNumber);
  return known.length > 0 ? Math.min(...known) : 'unreadable';
}

function nameBound(name: string, view: View, use: Use, deadline: boolean, depth: number): Bound {
  const declared = definition(view, use, name);
  if (!declared) return serverApart(view, name) ? undefined : 'unreadable';
  if (depth > 3) return undefined;
  const values = valuesOf(view, declared, name).filter(value => declared.scope !== view.scope || (value.start ?? 0) < use.at);
  if (values.length === 0) return declared.kind === 'param' && !declared.init ? 'unreadable' : undefined;
  return minimum(values.map(value => {
    if (deadline && value.type === 'BinaryExpression' && value.operator === '+' && serverClock(value.left)) return serverBound(value.right, view, use, false, depth + 1);
    return serverBound(value, view, use, false, depth + 1);
  }));
}

function reader(view: View, use: Use, depth = 0): Read {
  return name => {
    const value = nameBound(name, view, use, false, depth);
    return isNumber(value) ? value : undefined;
  };
}

/** Resolve the server's number/path forms without discarding an unevaluable possible value. */
function serverBound(node: Node, view: View, use: Use, deadline = false, depth = 0): Bound {
  if (node.type === 'Identifier' && !namedNumbers.has(node.name)) return nameBound(node.name, view, use, deadline, depth);
  if (deadline && node.type === 'BinaryExpression' && node.operator === '+' && serverClock(node.left)) return serverBound(node.right, view, use, false, depth);
  const number = serverNumber(node, reader(view, use, depth));
  if (number !== undefined) return number;
  if (!isPath(node)) return undefined;
  const root = pathRoot(node);
  return root !== undefined && !declaredHere(view, use, root) && !serverApart(view, root) ? 'unreadable' : undefined;
}

function pathRoot(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  return node.type === 'MemberExpression' ? pathRoot(node.object) : undefined;
}

/** Only a direct deadline definition or an inline start + limit uses server clock arithmetic. */
function clockLimit(node: Node, view: View, use: Use): Bound {
  if (node.type === 'BinaryExpression' && node.operator === '+' && isPath(node.left)) return serverBound(node.right, view, use);
  return serverBound(node, view, use, true);
}

/** Per-rule policy: the cockpit retains its original evaluator unchanged. */
export const serverDeadlineEvaluation: DeadlineEvaluation = {
  clock: serverClock,
  clockLimit,
  outside: (node, view, use) => serverBound(node, view, use) === 'unreadable',
  read: reader,
  delay(node, view) {
    // The original server scan reads intervals at the loop head, before its body runs.
    const use = { chain: [...view.above, view.loop], at: view.loop.start ?? 0 };
    const value = serverBound(node, view, use);
    return value === undefined && outside(node, view, use) ? 'unreadable' : value;
  },
  value(node, view, use) {
    const value = clockLimit(node, view, use);
    return isNumber(value) ? value : undefined;
  },
};
