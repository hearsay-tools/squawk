import { createRequire } from 'node:module';
import { join } from 'node:path';
import { child, stringOf, type AstContext, type EsNode, type Visitors } from './ast-rule.ts';
import { repoRoot } from './source-rule.ts';

/**
 * ESTree helpers for AST rules whose decision reads more than one node (hearsay-tools/squawk#3806),
 * and the scan that runs such a rule's visitors outside oxlint, for repository checks and tests.
 */

const isNode = (value: unknown): value is EsNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** `node` without the `ChainExpression` around it: the rules read `a?.b` as the member itself. */
export function bare(node: EsNode | undefined): EsNode | undefined {
  return node?.type === 'ChainExpression' ? child(node, 'expression') : node;
}

/** The child node in `key`, read through a `ChainExpression`. */
export function field(node: EsNode, key: string): EsNode | undefined {
  return bare(child(node, key));
}

/** The node in list `key` at `index`, read through a `ChainExpression`. */
export function item(node: EsNode, key: string, index: number): EsNode | undefined {
  const list = node[key];
  if (!Array.isArray(list)) return undefined;
  const value: unknown = list.at(index);
  return isNode(value) ? bare(value) : undefined;
}

/** Whether `node` is a method's function: its fields belong to the method, which is reported instead. */
export function methodValue(node: EsNode): boolean {
  const owner = node.parent;
  if (!owner || owner.value !== node) return false;
  return owner.type === 'MethodDefinition' || owner.type === 'TSAbstractMethodDefinition' || (owner.type === 'Property' && owner.method === true);
}

/**
 * The node a finding at `node` is reported on: the outermost node that starts where `node` starts.
 * The rules reported a scanned offset on the first node at that offset in source order, so a
 * finding keeps its span (hearsay-tools/squawk#3806).
 */
export function reportNode(node: EsNode): EsNode {
  let found = node;
  for (let owner = node.parent; owner && owner.start === node.start; owner = owner.parent) {
    if (!methodValue(owner)) found = owner;
  }
  return found;
}

const isMethod = (node: EsNode): boolean => node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition' || (node.type === 'Property' && node.method === true);

/**
 * Items in the order the rules saw their nodes before they read oxlint's tree (hearsay-tools/squawk#3806):
 * a method's own function (type parameters, parameters, body) first, then its decorators and key.
 * Oxlint visits a method's decorators and key first; everywhere else both orders agree. Rules
 * whose facts depend on order, such as names numbered by repeat or aliases bound in turn, add
 * items as oxlint visits and read them back in this order.
 *
 * Each method opens a frame when oxlint enters it; items added before oxlint enters the method's
 * function wait in that frame and follow the function's items when the method ends. `wrap` adds
 * this to a rule's visitors: the rule sees a method before its frame opens, and a method's
 * function after the frame closes, so both land where the old walk had them.
 */
export function viewOrder<T>(): { wrap(rule: Visitors): Visitors; add(item: T): void; items(): readonly T[] } {
  const ordered: T[] = [];
  const frames: { method: EsNode; open: boolean; waiting: T[] }[] = [];
  const target = (): T[] => {
    for (let index = frames.length - 1; index >= 0; index--) if (frames[index]!.open) return frames[index]!.waiting;
    return ordered;
  };
  const enter = (node: EsNode) => { if (isMethod(node)) frames.push({ method: node, open: true, waiting: [] }); };
  const leave = (node: EsNode) => {
    if (frames.at(-1)?.method !== node) return;
    const { waiting } = frames.pop()!;
    target().push(...waiting);
  };
  const enterFunction = (node: EsNode) => {
    const frame = frames.at(-1);
    if (frame && frame.method === node.parent && methodValue(node)) frame.open = false;
  };
  const methods: Visitors = {};
  for (const type of ['MethodDefinition', 'TSAbstractMethodDefinition', 'Property']) {
    methods[type] = enter;
    methods[`${type}:exit`] = leave;
  }
  const functions: Visitors = { FunctionExpression: enterFunction, TSEmptyBodyFunctionExpression: enterFunction };
  return { wrap: rule => mergeVisitors(functions, rule, methods), add: item => target().push(item), items: () => ordered };
}

/** One visitor set that calls each set's visitor for a node type, in the order the sets are given. */
function mergeVisitors(...sets: Visitors[]): Visitors {
  const merged: Visitors = {};
  for (const set of sets) {
    for (const [type, visit] of Object.entries(set)) {
      const before = merged[type];
      merged[type] = before ? (node: EsNode) => { before(node); visit(node); } : visit;
    }
  }
  return merged;
}

/** Call `visit` for each child node of `node`, in field order. For short walks of a small subtree only. */
export function eachChild(node: EsNode, visit: (child: EsNode) => void): void {
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const entry of value) if (isNode(entry)) visit(entry); }
    else if (isNode(value)) visit(value);
  }
}

/** Static text in the key forms the rules recognize: a string, a plain template, `+` of both, through casts. */
export function staticNodeText(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  const literal = stringOf(node);
  if (literal !== undefined) return literal;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticNodeText(child(node, 'left'));
    const right = left === undefined ? undefined : staticNodeText(child(node, 'right'));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(node.type)) return staticNodeText(child(node, 'expression'));
  return undefined;
}

type RuleTesterModule = typeof import('oxlint/plugins-dev');

/**
 * The tester case that parses `source` as `file`. Oxlint takes the language from the extension, but
 * knows no JSX in `.cjsx`, `.mjsx`, `.ctsx` or `.mtsx`; those files name their language instead.
 */
function parseCase(file: string, source: string) {
  const jsx = /\.[cm]([jt])sx$/.exec(file);
  if (!jsx) return { code: source, filename: join(repoRoot, file), languageOptions: { parserOptions: { ignoreNonFatalErrors: true } } };
  const lang = jsx[1] === 't' ? 'tsx' as const : 'jsx' as const;
  return { code: source, languageOptions: { sourceType: 'unambiguous' as const, parserOptions: { lang, ignoreNonFatalErrors: true } } };
}
let tester: RuleTesterModule['RuleTester'] | undefined;

/**
 * Parse `source` as oxlint does at `file`, in this process, and run `create`'s visitors on it.
 * Throws when oxlint cannot parse the source. Oxlint's `RuleTester` does the parse, so this must
 * never run inside an oxlint run: the tester resets oxlint's loaded rules when it ends. It loads
 * only on the first scan, so a lint run never loads it.
 */
export function scanSource(file: string, source: string, create: (sourceCode: AstContext['sourceCode']) => Visitors): void {
  tester ??= (createRequire(import.meta.url)('oxlint/plugins-dev') as RuleTesterModule).RuleTester;
  const previous = { describe: tester.describe, it: tester.it };
  const immediate = (_name: string, run: () => void) => run();
  try {
    tester.describe = immediate as typeof tester.describe;
    tester.it = immediate as typeof tester.it;
    const rule = { meta: { type: 'problem' as const }, create: (context: { sourceCode: AstContext['sourceCode'] }) => create(context.sourceCode) };
    new tester({ cwd: repoRoot }).run('scan', rule as unknown as Parameters<InstanceType<RuleTesterModule['RuleTester']>['run']>[1], {
      valid: [parseCase(file, source)],
      invalid: [],
    });
  } finally {
    tester.describe = previous.describe;
    tester.it = previous.it;
  }
}
