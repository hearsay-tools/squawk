import type { WaitSource } from './wait-source.ts';

/**
 * One server test file's syntax tree as the wait rule reads it (hearsay-tools/squawk#3774): oxlint's
 * ESTree nodes, with the `parent` link oxlint sets. The name index is built once per file, on the
 * first question that needs it, and never for a file whose waits need no name.
 */

/** A syntax node with the fields of every type it can be. */
export interface N {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  // oxlint-disable-next-line no-explicit-any -- an ESTree node's fields differ per type; each reader checks `type` first.
  readonly [field: string]: any;
}

export const isFunction = (node: N | undefined): boolean => node !== undefined && (node.type === 'FunctionDeclaration'
  || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');

export const isLoop = (node: N | undefined): boolean => node !== undefined && (node.type === 'ForStatement' || node.type === 'WhileStatement'
  || node.type === 'DoWhileStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement');

/** Literals by what they hold: oxlint's ESTree has one `Literal` type for all of them. */
export const isNumberLiteral = (node: N | undefined): boolean => node?.type === 'Literal' && typeof node.value === 'number';
export const isBigIntLiteral = (node: N | undefined): boolean => node?.type === 'Literal' && (typeof node.value === 'bigint' || typeof node.bigint === 'string');
export const isStringLiteral = (node: N | undefined): boolean => node?.type === 'Literal' && typeof node.value === 'string';
export const isNullLiteral = (node: N | undefined): boolean => node?.type === 'Literal' && node.value === null && !node.regex && node.bigint === undefined;

/** The fields of a node that are not syntax. */
const META = new Set(['type', 'parent', 'start', 'end', 'range', 'loc']);

/** Calls `each` with every child node of a node, in source order. */
function eachChild(node: N, each: (child: N) => void): void {
  for (const key of Object.keys(node)) {
    if (META.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') each(item);
    } else if (value && typeof value.type === 'string') each(value);
  }
}

/** The child nodes of a node, in source order. */
export function childrenOf(node: N): N[] {
  const out: N[] = [];
  eachChild(node, child => out.push(child));
  return out;
}

/** Every node of the tree under `root`, parents first. One scratch list serves every node. */
export function walkAll(root: N, visit: (node: N) => void): void {
  const stack: N[] = [root];
  const children: N[] = [];
  const collect = (child: N) => { children.push(child); };
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    children.length = 0;
    eachChild(node, collect);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
}

/** The nodes a `{ … }` pair belongs to, so a name declared inside one is out of view once it closes. */
const BRACES = new Set(['BlockStatement', 'ObjectExpression', 'ObjectPattern', 'ClassBody', 'StaticBlock', 'TSModuleBlock', 'TSTypeLiteral',
  'TSInterfaceBody', 'SwitchStatement', 'TSEnumDeclaration', 'TSEnumBody', 'TemplateLiteral']);

/** Whether `child` of `node` sits between its braces: the cases of a `switch`, not its discriminant. */
export function insideBraces(node: N, child: N): boolean {
  if (!BRACES.has(node.type)) return false;
  if (node.type === 'SwitchStatement') return child !== node.discriminant;
  if (node.type === 'TSEnumDeclaration') return child !== node.id;
  if (node.type === 'TemplateLiteral') return node.expressions.includes(child);
  return true;
}

/** A word the way the text reads one: an identifier, `this`, `true`, `false` or `null`. */
export function wordOf(node: N): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Literal' && (typeof node.value === 'boolean' || isNullLiteral(node))) return String(node.value);
  return undefined;
}

/** A name or a path of names written without spaces: `deadline`, `state.t0`, `this.limit`. */
export function pathOf(tree: WaitTree, node: N): string | undefined {
  if (node.type !== 'MemberExpression') return wordOf(node);
  if (node.computed || node.optional || node.property.type !== 'Identifier' || node.property.start !== node.object.end + 1 || tree.text[node.object.end] !== '.') return undefined;
  const object = pathOf(tree, node.object);
  return object === undefined ? undefined : `${object}.${node.property.name}`;
}

export class WaitTree {
  readonly root: N;
  readonly source: WaitSource;
  #indexed = false;
  readonly #identifiers = new Map<string, N[]>();
  readonly #functions: N[] = [];
  readonly #continues: N[] = [];
  readonly #params = new Map<N, number>();

  constructor(root: N, source: WaitSource) {
    this.root = root;
    this.source = source;
  }

  get text(): string {
    return this.source.text;
  }

  #index(): void {
    if (this.#indexed) return;
    this.#indexed = true;
    walkAll(this.root, node => {
      if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
        const list = this.#identifiers.get(node.name);
        if (list) list.push(node);
        else this.#identifiers.set(node.name, [node]);
      } else if (isFunction(node)) this.#functions.push(node);
      else if (node.type === 'ContinueStatement') this.#continues.push(node);
    });
  }

  parent(node: N): N | undefined {
    return node.parent ?? undefined;
  }

  /** The nodes above `node`, nearest first. */
  *ancestors(node: N): Generator<N> {
    for (let at = this.parent(node); at; at = this.parent(at)) yield at;
  }

  /** Every identifier, private name included, spelled `name`, in source order. */
  identifiers(name: string): readonly N[] {
    this.#index();
    return this.#identifiers.get(name) ?? [];
  }

  /** Every function in the file, in source order. */
  get functions(): readonly N[] {
    this.#index();
    return this.#functions;
  }

  /** Every `continue` statement, in source order. */
  get continues(): readonly N[] {
    this.#index();
    return this.#continues;
  }

  /** Whether `offset` sits in the body of `fn`: its block, or the expression after its `=>`. Its parameters are outside. */
  inFrame(fn: N, offset: number): boolean {
    return fn.body !== null && fn.body !== undefined && offset >= fn.body.start && offset < fn.body.end;
  }

  /** The functions whose body holds `node`, outermost first. */
  chainOf(node: N): N[] {
    const chain: N[] = [];
    for (const above of this.ancestors(node)) if (isFunction(above) && this.inFrame(above, node.start)) chain.unshift(above);
    return chain;
  }

  /** Whether `offset` sits in the body of a function that is not one of `chain`. */
  inOtherFrame(offset: number, chain: readonly N[]): boolean {
    return this.functions.some(fn => this.inFrame(fn, offset) && !chain.includes(fn));
  }

  /**
   * Where a function's parameter list starts, read the way a scan of the text finds it from the function's
   * body: the `(` that the `)` before the body or the `=>` closes, or the one before a return type written
   * on the body's line without `;`, `{`, `}`, `(`, `)` or `=`. A function with neither has no list to read,
   * and its list starts where its body does.
   */
  paramsStart(fn: N): number {
    const known = this.#params.get(fn);
    if (known !== undefined) return known;
    const found = this.#paramsStart(fn);
    this.#params.set(fn, found);
    return found;
  }

  #paramsStart(fn: N): number {
    const { text } = this;
    const concise = fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement';
    const open = concise ? this.arrowAt(fn) : fn.body.start;
    let k = this.source.before(open);
    if (!concise && text[k] === '>' && text[k - 1] === '=') k = this.source.before(k - 1);
    if (text[k] === ')') return this.openParen(fn, k);
    const typed = fn.returnType && (concise || fn.type !== 'ArrowFunctionExpression') ? this.typedClose(fn, open) : -1;
    return typed === -1 ? open : this.openParen(fn, typed);
  }

  /** The `=` of an arrow function's `=>`. */
  arrowAt(fn: N): number {
    let k = this.source.before(fn.body.start);
    while (this.text[k] === '(') k = this.source.before(k);
    return this.text[k] === '>' ? k - 1 : fn.body.start;
  }

  /** The `)` before a return type, when the type sits on the body's line and holds none of `;{}()=`. */
  typedClose(fn: N, open: number): number {
    const close = this.source.before(fn.returnType.start);
    const between = this.text.slice(close + 1, open);
    return this.text[close] === ')' && /^\s*:/.test(between) && !/[;{}()=\n]/.test(between.replace(/^\s*:/, '')) ? close : -1;
  }

  /** The `(` that opens a function's parameter list, given the `)` that closes it. */
  openParen(fn: N, close: number): number {
    const first: N | undefined = fn.params[0];
    let at = first ? first.start : close;
    if (first?.decorators?.length) at = first.decorators[0].start;
    const open = this.source.before(at);
    return this.text[open] === '(' ? open : fn.body.start;
  }

  /**
   * The innermost `{ … }` around `node` that opened before it, or `undefined` at the top of the file. A name
   * set inside it is in view only while it is open.
   */
  braceAround(node: N): N | undefined {
    let child = node;
    for (const above of this.ancestors(node)) {
      if (insideBraces(above, child)) return above;
      child = above;
    }
    return undefined;
  }
}
