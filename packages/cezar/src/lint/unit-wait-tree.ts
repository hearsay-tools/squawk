import type { N } from './server-wait-tree.ts';

/**
 * The shapes the cockpit wait scan reads on oxlint's ESTree nodes, in place (hearsay-tools/squawk#3806).
 * The scan was written for Babel's node types, and these readers keep what those types meant:
 *
 * - A method (`m() {}` in an object, a class method) is one function node: its function's fields are read as its own, and
 *   the `FunctionExpression` that oxlint keeps as its `value` is not a node of its own. A private (`#m() {}`), abstract or
 *   bodiless class method is no function: its body is read as part of the function around the class.
 * - A call or member access at or past the first optional link of a chain (`a?.b`, `a?.b.c()`) is none of the plain shapes the
 *   scan matches; the base of the chain stays plain. The `ChainExpression` around a chain matches no shape either.
 * - A private name (`#limit`) is read as a name where the scan collects the names an expression reads.
 */

export type { N };

/** Returns `false` to leave a node's children unvisited. */
export type Visit = (node: N, ancestors: readonly N[]) => void | false

/** The fields of a node that are not its syntax children. */
const META = new Set(['type', 'start', 'end', 'range', 'loc', 'parent', 'tokens', 'comments'])

const isSyntax = (value: unknown): value is N => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

/** A method whose function's fields the scan reads as its own: an object method, or any class method. */
export const isMethod = (node: N): boolean =>
  node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition' || (node.type === 'Property' && node.method === true)

/** A class method with a body and a key that is not private: the one class member the scan reads as a function. */
const isClassFunction = (node: N): boolean =>
  node.type === 'MethodDefinition' && node.value?.type !== 'TSEmptyBodyFunctionExpression' && node.key?.type !== 'PrivateIdentifier'

export const isFunction = (node: N): boolean =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' ||
  (node.type === 'Property' && node.method === true) || isClassFunction(node)

/** A function's parameters; a method's are its function's. */
export const paramsOf = (node: N): readonly N[] | undefined => {
  const params: unknown = isMethod(node) ? node.value?.params : node.params
  return Array.isArray(params) ? params : undefined
}

function walkFields(node: N, skip: string | undefined, ancestors: N[], visit: Visit): void {
  for (const key of Object.keys(node)) {
    if (META.has(key) || key === skip) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isSyntax(item)) walk(item, ancestors, visit)
    } else if (isSyntax(value)) walk(value, ancestors, visit)
  }
}

/** Child nodes in source order, walked in place so no node allocates a child list. A method's function fields come first, as its own. */
export function walk(node: N, ancestors: N[], visit: Visit): void {
  if (visit(node, ancestors) === false) return
  ancestors.push(node)
  if (isMethod(node) && isSyntax(node.value)) {
    walkFields(node.value, undefined, ancestors, visit)
    walkFields(node, 'value', ancestors, visit)
  } else walkFields(node, undefined, ancestors, visit)
  ancestors.pop()
}

/** The receiver a chain continues through: a member's object, a call's callee, a non-null assertion's expression. */
function receiverOf(node: N): N | undefined {
  const next: unknown = node.type === 'MemberExpression' ? node.object : node.type === 'CallExpression' ? node.callee : node.type === 'TSNonNullExpression' ? node.expression : undefined
  return isSyntax(next) ? next : undefined
}

/** Whether a link sits at or past the first optional link of its chain. A parenthesized chain (`(a?.b).c`) ends there. */
export function inOptionalChain(node: N): boolean {
  for (let link: N | undefined = node; link; link = receiverOf(link)) if (link.optional === true) return true
  return false
}

/** A call outside an optional chain. */
export const isCall = (node: N | null | undefined): boolean => node?.type === 'CallExpression' && !inOptionalChain(node)

/** A member access outside an optional chain. */
export const isMember = (node: N | null | undefined): boolean => node?.type === 'MemberExpression' && !inOptionalChain(node)

/** An object property that is not a method: a getter or setter is one, as Babel's `ObjectProperty` was. */
export const isObjectProperty = (node: N | undefined): boolean => node?.type === 'Property' && node.method !== true
