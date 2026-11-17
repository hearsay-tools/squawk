import { childrenOf, pathOf, walkAll, type N, type WaitTree } from './server-wait-tree.ts';

export { childrenOf, walkAll };

/**
 * What a name holds where the server wait rule reads it (hearsay-tools/squawk#3774). The rule's
 * list (in `test-wait-discipline.ts`) reads a name in the function around its use and in every
 * function around that one, up to the module, from the assignments written before the use whose
 * `{ … }` is still open there. A function nested beside the use keeps its names to itself.
 */

/** Where a name is read: the functions around the use, outermost first, and whether the use is a wait (a parameter's default is not its bound). */
export interface Place {
  chain: readonly N[];
  /** Where each scope's text starts: the module, then each function's parameter list. */
  bounds: readonly number[];
  wait: boolean;
}

export function placeOf(tree: WaitTree, node: N, wait: boolean): Place {
  const chain = tree.chainOf(node);
  return { chain, bounds: [0, ...chain.map(fn => tree.paramsStart(fn))], wait };
}

/** How the text before an assignment reads: a declaration, a parameter (after `(` or `,`), or a plain write. */
export type Before = 'const' | 'let' | 'param' | 'plain';

/** One `name = value` in the file: where the name is, the value, and what comes before it. */
export interface Assignment {
  at: number;
  name: N;
  value: N;
  before: Before;
}

/** A value the rule cannot read: a name of an outer scope that is written after its declaration. */
export const UNREAD = Symbol('unread');

export interface Held {
  value: N | typeof UNREAD;
  at: number;
  param: boolean;
}

/** Whether a type annotation reads as the text between a name and its `=`: no `=`, `;`, `,`, `(` or `)` in it. */
const plainType = (tree: WaitTree, annotation: N | undefined): boolean => !annotation || !/[=;,()]/.test(tree.text.slice(annotation.start, annotation.end));

export class WaitNames {
  readonly tree: WaitTree;
  readonly #assignments = new Map<string, Assignment[]>();
  #writes: Map<string, Array<{ at: number; plain: boolean }>> | undefined;
  #apart: Set<string> | undefined;

  constructor(tree: WaitTree) {
    this.tree = tree;
  }

  #before(name: N): Before {
    const { source, text } = this.tree;
    const k = source.before(name.start);
    const word = source.wordEndingAt(k);
    if (word === 'const') return 'const';
    if (text[k] === '(' || text[k] === ',') return 'param';
    return word === 'let' || word === 'var' ? 'let' : 'plain';
  }

  /** Every `name = value` in the file the rule reads as one, in source order. */
  assignments(name: string): readonly Assignment[] {
    let found = this.#assignments.get(name);
    if (found) return found;
    found = [];
    for (const id of this.tree.identifiers(name)) {
      const value = this.#assignedValue(id);
      if (value) found.push({ at: id.start, name: id, value, before: this.#before(id) });
    }
    this.#assignments.set(name, found);
    return found;
  }

  #assignedValue(id: N): N | undefined {
    const { tree } = this;
    const parent = tree.parent(id);
    if (!parent) return undefined;
    const typed = plainType(tree, id.typeAnnotation) && !id.optional;
    switch (parent.type) {
      case 'VariableDeclarator': return parent.id === id && typed ? parent.init ?? undefined : undefined;
      case 'AssignmentExpression': return parent.left === id && parent.operator === '=' ? parent.right : undefined;
      case 'AssignmentPattern': return parent.left === id && typed ? parent.right : undefined;
      case 'PropertyDefinition': return parent.key === id && !parent.computed && plainType(tree, parent.typeAnnotation) ? parent.value ?? undefined : undefined;
      case 'TSEnumMember': return parent.id === id ? parent.initializer ?? undefined : undefined;
      case 'Property': return this.#renamedValue(parent, id);
      default: return undefined;
    }
  }

  /** `{ name: other = value }` gives `name` the default, and `{ …, name: other } = value`, as its last key, the value after the pattern. */
  #renamedValue(property: N, id: N): N | undefined {
    const pattern = this.tree.parent(property);
    if (property.key !== id || property.computed || property.shorthand || pattern?.type !== 'ObjectPattern') return undefined;
    if (property.value.type === 'AssignmentPattern') return property.value.left.type === 'Identifier' && !property.value.left.typeAnnotation ? property.value.right : undefined;
    if (property.value.type !== 'Identifier' || pattern.properties.at(-1) !== property) return undefined;
    const holder = this.tree.parent(pattern);
    if (holder?.type === 'VariableDeclarator' && holder.id === pattern && !pattern.typeAnnotation) return holder.init ?? undefined;
    if (holder?.type === 'AssignmentExpression' && holder.left === pattern && holder.operator === '=') return holder.right;
    return holder?.type === 'AssignmentPattern' && holder.left === pattern ? holder.right : undefined;
  }

  /** The depth of the scope an offset is in: 0 for the module, then one per function of the chain. */
  depthOf(place: Place, offset: number): number {
    return place.bounds.filter(start => start <= offset).length - 1;
  }

  /**
   * The values the code at `at` can see given to `name`. A declaration in a scope hides the name in the scopes
   * around it. The use's own function gives every value the name can hold there. A name of an outer scope holds
   * one value: a `const`, or a parameter's default; a `let` or `var` is read only when nothing in the file writes
   * it after its declaration, else it is `UNREAD`. A `const` of the module counts wherever it sits, since a
   * function runs after the module has loaded, unless a nearer scope declares the name.
   */
  held(place: Place, name: string, at: number): Held[] {
    const found = this.assignments(name).filter(each => this.#visible(place, each, at)).map(each => ({ ...each, depth: this.depthOf(place, each.at) }));
    const declares = found.filter(each => each.before !== 'plain').map(each => each.depth);
    const innermost = Math.max(-1, ...declares, ...this.#paramDepths(place, name));
    const own = place.bounds.length - 1;
    const values: Held[] = found.filter(each => each.depth >= innermost && !(place.wait && each.before === 'param')).map(each => {
      const constant = each.before === 'const' || each.before === 'param';
      const readable = constant || (each.depth === own && !place.wait) || (each.before === 'let' && !this.writes(name, true));
      return { value: readable ? each.value : UNREAD, at: each.value.start, param: each.before === 'param' };
    });
    if (innermost !== -1 || place.chain.length === 0) return values;
    return [...values, ...this.#lateConstants(name, at)];
  }

  #visible(place: Place, each: Assignment, at: number): boolean {
    if (each.at >= at || this.tree.inOtherFrame(each.at, place.chain)) return false;
    const brace = this.tree.braceAround(each.name);
    return brace === undefined || (brace.start < at && brace.end > at);
  }

  /** The depths of the functions whose parameter list binds `name`: a parameter hides the same name of the scopes around it. */
  #paramDepths(place: Place, name: string): number[] {
    return place.chain.flatMap((fn, index) => (this.tree.text[place.bounds[index + 1] ?? -1] === '(' && fn.params.some((param: N) => this.#binds(param, name)) ? [index + 1] : []));
  }

  #binds(param: N, name: string): boolean {
    const first = param.type === 'AssignmentPattern' ? param.left : param.type === 'RestElement' ? param.argument : param;
    if (first.type === 'Identifier') return first.name === name;
    if (param.type === 'TSParameterProperty') return /^[A-Za-z_$][\w$]*/.exec(this.tree.text.slice(param.start, param.end))?.[0] === name;
    return this.tree.identifiers(name).some(id => id.start >= param.start && id.end <= param.end && !this.#isProperty(id));
  }

  #isProperty(id: N): boolean {
    const parent = this.tree.parent(id);
    return (parent?.type === 'MemberExpression' || parent?.type === 'TSQualifiedName') && (parent.property === id || parent.right === id) && !parent.computed;
  }

  /** `const name = …` at the module, after `at`: a function runs after the module has loaded. */
  #lateConstants(name: string, at: number): Held[] {
    return this.assignments(name)
      .filter(each => each.at >= at && each.before === 'const' && !this.tree.functions.some(fn => this.tree.inFrame(fn, each.at)))
      .map(each => ({ value: each.value, at: each.value.start, param: false }));
  }

  /**
   * Where the file writes `name`: `name++`, `--name`, `name += 1`, a destructuring target or a `[name]` that is
   * assigned to, and, as `plain`, `name = …` other than a declaration. `plain` asks for both kinds.
   */
  writesAt(name: string): ReadonlyArray<{ at: number; plain: boolean }> {
    this.#writes ??= this.#indexWrites();
    return this.#writes.get(name) ?? [];
  }

  writes(name: string, plain: boolean, within?: (at: number) => boolean): boolean {
    return this.writesAt(name).some(each => (plain || !each.plain) && (!within || within(each.at)));
  }

  #indexWrites(): Map<string, Array<{ at: number; plain: boolean }>> {
    const writes = new Map<string, Array<{ at: number; plain: boolean }>>();
    const add = (name: string, at: number, plain: boolean): void => {
      const list = writes.get(name);
      if (list) list.push({ at, plain });
      else writes.set(name, [{ at, plain }]);
    };
    const visit = (node: N): void => {
      for (const [name, at, plain] of writeForms(this, node)) add(name, at, plain);
    };
    walkAll(this.tree.root, visit);
    return writes;
  }

  /** Whether the file declares `name` where a plain `name = value` cannot be read: a function or class, destructuring, or the variable of a `for`. */
  declaredApart(name: string): boolean {
    this.#apart ??= apartNames(this.tree);
    return this.#apart.has(name);
  }

  /** Whether the file declares `name` itself. A parameter and an import are the caller's. */
  declaredHere(place: Place, name: string, at: number): boolean {
    return this.held(place, name, at).some(each => !each.param) || this.declaredApart(name);
  }
}

const bare = (names: WaitNames, id: N): boolean => {
  const parent = names.tree.parent(id);
  return !(parent?.type === 'MemberExpression' && parent.property === id && !parent.computed);
};

/** The identifiers under `node`, not property names after a `.`. */
function bareNames(names: WaitNames, node: N): string[] {
  const found: string[] = [];
  const seen = new Set<number>();
  const visit = (at: N): void => {
    // A shorthand property's key and value are two nodes at one offset; the text holds one name there.
    if (at.type === 'Identifier' && bare(names, at) && !seen.has(at.start)) {
      seen.add(at.start);
      found.push(at.name);
    }
    for (const child of childrenOf(at)) visit(child);
  };
  visit(node);
  return found;
}

/** Whether the text between two bracket offsets holds another bracket of the pair: then the first pair the text closes is not this one. */
function nests(tree: WaitTree, open: number, close: number, pair: string): boolean {
  for (let i = open + 1; i < close; i += 1) if (pair.includes(tree.text[i] ?? '') && !tree.source.commentAt(i)) return true;
  return false;
}

/** Whether `=` (not `==` or `=>`) follows the bracket that closes `node`. */
function assignedAfter(tree: WaitTree, end: number): boolean {
  const k = tree.source.after(end);
  return tree.text[k] === '=' && tree.text[k + 1] !== '=' && tree.text[k + 1] !== '>';
}

/** The writes one node makes, as `[name, offset, plain]`. */
function writeForms(names: WaitNames, node: N): Array<[string, number, boolean]> {
  switch (node.type) {
    case 'UpdateExpression': {
      const path = node.argument.type === 'Identifier' || node.argument.type === 'MemberExpression' ? pathOf(names.tree, node.argument) : undefined;
      return path === undefined ? [] : [[path, node.argument.start, false]];
    }
    case 'AssignmentExpression': return assignmentWrites(names, node);
    case 'AssignmentPattern': return node.left.type === 'Identifier' && !node.left.typeAnnotation ? [[node.left.name, node.left.start, true]] : [];
    case 'VariableDeclarator': return declaratorWrites(names, node);
    case 'PropertyDefinition': {
      const key = node.key;
      return (key.type === 'Identifier' || key.type === 'PrivateIdentifier') && node.value && !node.typeAnnotation && !node.computed ? [[key.name, key.start, true]] : [];
    }
    case 'TSEnumMember': return node.id.type === 'Identifier' && node.initializer ? [[node.id.name, node.id.start, true]] : [];
    case 'ArrayPattern': case 'ObjectPattern': case 'TSTypeLiteral': case 'TSTupleType': return bracketWrites(names, node);
    default: return [];
  }
}

function assignmentWrites(names: WaitNames, node: N): Array<[string, number, boolean]> {
  const left = node.left;
  if (left.type === 'Identifier') return [[left.name, left.start, node.operator === '=']];
  const path = left.type === 'MemberExpression' ? pathOf(names.tree, left) : undefined;
  if (path !== undefined) return [[path, left.start, node.operator === '=']];
  if (left.type !== 'MemberExpression' || !left.computed || node.operator !== '=') return [];
  const open = names.tree.source.before(left.property.start);
  const close = names.tree.source.after(left.property.end);
  return nests(names.tree, open, close, '[]') ? [] : bareNames(names, left.property).map(name => [name, left.property.start, false]);
}

function declaratorWrites(names: WaitNames, node: N): Array<[string, number, boolean]> {
  const { tree } = names;
  if (node.id.type !== 'Identifier' || !node.init || node.id.typeAnnotation) return [];
  const word = tree.source.wordEndingAt(tree.source.before(node.id.start));
  return word === 'let' || word === 'const' || word === 'var' ? [] : [[node.id.name, node.id.start, true]];
}

/** `[a, b] = …`, `{ a, b } = …`: each bare name in a bracket pair with no pair of its kind inside, followed by `=`. */
function bracketWrites(names: WaitNames, node: N): Array<[string, number, boolean]> {
  const { tree } = names;
  const [open, close] = node.type === 'ArrayPattern' || node.type === 'TSTupleType' ? ['[', ']'] : ['{', '}'];
  const end = node.end - 1;
  if (node.typeAnnotation || tree.text[node.start] !== open || tree.text[end] !== close) return [];
  return nests(tree, node.start, end, open + close) || !assignedAfter(tree, end + 1) ? [] : bareNames(names, node).map(name => [name, node.start, false]);
}

/** The names the file declares as a function, a class, a destructured binding or a `for` variable. */
function apartNames(tree: WaitTree): Set<string> {
  const found = new Set<string>();
  const gapBefore = (id: N): boolean => tree.source.before(id.start) < id.start - 1;
  walkAll(tree.root, node => {
    if (['FunctionDeclaration', 'FunctionExpression', 'TSDeclareFunction', 'ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id && gapBefore(node.id)) found.add(node.id.name);
    if (node.type === 'VariableDeclaration') destructured(tree, node, found);
    if ((node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement')) {
      const head = node.type === 'ForStatement' ? node.init : node.left;
      const first = head?.type === 'VariableDeclaration' ? head.declarations[0] : undefined;
      if (first?.id.type === 'Identifier') found.add(first.id.name);
    }
  });
  return found;
}

/** `const { a, b: c } = …` with no `=` inside the pattern: every name in it, and each name a word of it ends with. */
function destructured(tree: WaitTree, declaration: N, found: Set<string>): void {
  const first = declaration.declarations[0];
  if (!first?.init || (first.id.type !== 'ObjectPattern' && first.id.type !== 'ArrayPattern')) return;
  const before = tree.source.wordEndingAt(tree.source.before(first.id.start));
  if (before !== 'let' && before !== 'const' && before !== 'var') return;
  const end = tree.source.before(first.init.start);
  const inside = tree.text.slice(first.id.start, end);
  const last = tree.source.before(end);
  if (tree.text[end] !== '=' || /[;=]/.test(inside.replace(/\/\*[\s\S]*?\*\//g, '')) || !']}'.includes(tree.text[last] ?? '')) return;
  for (const word of inside.match(/[A-Za-z_$][\w$]*/g) ?? []) for (let i = 0; i < word.length; i += 1) found.add(word.slice(i));
}
