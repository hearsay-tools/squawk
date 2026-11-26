import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { lineAt, repoRoot } from './source-rule.ts';
import { child, children, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { eachChild, field, methodValue, reportNode, scanSource, viewOrder } from './ast-tree.ts';

/**
 * Shared parity rows run on one runner, and unit tests drive every other value of each turn-path
 * fact once, not every combination of values (hearsay-tools/cezarion#2991, docs/adr/0063-one-scenario-runner.md). That holds only while
 * no function above the seam combines two declared runner facts: such a function needs a
 * combination row on every runner.
 *
 * The rule over-approximates, so it fails closed. It tracks no value. It flags a function in a
 * non-test `workflows/` source when both hold, counting the function's nested callbacks as part
 * of it:
 *
 * (a) it touches a fact source: a `.inputDelivery`, `.facts` or `.systemPromptOnResume` property,
 *     the `RUNNER_FACTS` or `inputDeliveryOf` value, a destructuring key `inputDelivery`, `facts`
 *     or `systemPromptOnResume`, or the type `InputDelivery` or `RunnerFacts`. A name imported
 *     under another name, a namespace import's member and a local type alias of a source type
 *     count as the source. A source touched at module level, outside every function, counts as
 *     touched by every function in the file;
 * (b) it reads two or more different fact keys, by property name, static computed key (`d['mode']`,
 *     `` d[`mode`] ``) or destructuring key, from any object. The keys come from the declared types
 *     (`RunnerFacts` in `core/runner-facts.ts`, `InputDelivery` in `core/agent-runner.ts`), so a new
 *     fact joins the rule by itself.
 *
 * Aliases, block scopes, `??`, ternaries, reassignment, rest elements and parameter defaults are
 * all covered because no value is followed. Every qualifying function is reported, an outer
 * function with the reads of its nested callbacks, under a name qualified by its enclosing classes
 * and functions (`Runner>settle>inner`; repeats are numbered). A reported function is either a real
 * combination, which needs a parity row on every runner, or a false positive: an unrelated object
 * with a same-named key. Both go in `COMBINATION_ROWS` with a reason; a real combination also names
 * its row. An exception clears only the function it names.
 *
 * Limits: the rule does not see
 * - a fact read inside a helper function that the reported function calls, or a fact returned by
 *   one (each helper is checked on its own);
 * - a fact key read through a dynamic computed key (`d[key]`);
 * - a fact source carried in another object's property and read in a function that touches no
 *   source itself (`state.policy.mode` where `state.policy` was set elsewhere);
 * - a fact source imported from a module that re-exports it under another name, or passed in from
 *   another module.
 */

/** Declared keys that are no fact: each reason says why. */
const NOT_FACTS: Readonly<Record<string, string>> = {
  inputDelivery: 'the container of the delivery facts; reading it is a fact source',
  via: 'prose naming the native mechanism for the docs; no code decides on it',
};

const TYPE_FILES = { RunnerFacts: 'packages/cezar/src/core/runner-facts.ts', InputDelivery: 'packages/cezar/src/core/agent-runner.ts' } as const;

/** Every property key of the type literals and interfaces a type names, followed through `&`, `|`, parentheses and local interfaces. */
function typeKeys(program: Extract<Node, { type: 'Program' }>, name: string): string[] {
  const declarations = new Map<string, Node>();
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration') declarations.set(declaration.id.name, declaration);
  }
  const keysOf = (node: Node): string[] => {
    if (node.type === 'TSInterfaceDeclaration') return node.body.body.flatMap(keysOf);
    if (node.type === 'TSTypeAliasDeclaration') return keysOf(node.typeAnnotation);
    if (node.type === 'TSTypeLiteral') return node.members.flatMap(keysOf);
    if (node.type === 'TSIntersectionType' || node.type === 'TSUnionType') return node.types.flatMap(keysOf);
    if (node.type === 'TSParenthesizedType') return keysOf(node.typeAnnotation);
    if (node.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
      const local = declarations.get(node.typeName.name);
      return local ? keysOf(local) : [];
    }
    if (node.type === 'TSPropertySignature' && node.key.type === 'Identifier') return [node.key.name];
    return [];
  };
  const declaration = declarations.get(name);
  if (!declaration) throw new Error(`runner-fact-combination: ${name} is not declared where the rule reads it`);
  return keysOf(declaration);
}

/** The fact keys of the declared types, without the keys `NOT_FACTS` names. */
export function declaredFactKeys(read: (path: string) => string = path => readFileSync(join(repoRoot, path), 'utf8')): Set<string> {
  const keys = Object.entries(TYPE_FILES).flatMap(([name, path]) =>
    typeKeys(parse(read(path), { sourceType: 'module', plugins: ['typescript'] }).program, name));
  return new Set(keys.filter(key => !Object.hasOwn(NOT_FACTS, key)));
}

let factKeys: Set<string> | undefined;
// @babel/parser stays here: oxlint's in-process parser (RuleTester) resets a running lint, and this reads two files once per lint process (hearsay-tools/squawk#3806).
const FACT_KEYS = () => (factKeys ??= declaredFactKeys());

/** Property names and destructuring keys that make a function touch a fact source. */
const SOURCE_KEYS = new Set(['inputDelivery', 'facts', 'systemPromptOnResume']);
/** The canonical value and type names of the fact sources, as their modules export them. */
const SOURCE_NAMES = new Set(['RUNNER_FACTS', 'inputDeliveryOf']);
const SOURCE_TYPES = new Set(Object.keys(TYPE_FILES));

/**
 * The static key of a member's property or a pattern's property: `a.b`, `a['b']`, `` a[`b`] ``,
 * `{ b }`, `{ 'b': c }`. A dynamic computed key is undefined.
 */
function staticKey(key: EsNode | undefined, computed: boolean): string | undefined {
  if (!computed && key?.type === 'Identifier') return key.name as string;
  if (key?.type === 'Literal') return typeof key.value === 'string' ? key.value : undefined;
  return key?.type === 'TemplateLiteral' ? stringOf(key) : undefined;
}

/** The local names the file binds to a fact source: its imports (renamed or not, namespaces too)
 *  and its type aliases of a source type, so a renamed source is still a source. */
interface Names { values: Set<string>; types: Set<string>; namespaces: Set<string> }

/** A top-level statement, or the declaration an `export` wraps. */
const declarationOf = (statement: EsNode): EsNode => statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') ?? statement : statement;

function sourceNames(program: EsNode): Names {
  const names: Names = { values: new Set(SOURCE_NAMES), types: new Set(SOURCE_TYPES), namespaces: new Set() };
  const aliases: EsNode[] = [];
  for (const statement of children(program, 'body')) {
    const declaration = declarationOf(statement);
    if (declaration.type === 'TSTypeAliasDeclaration') aliases.push(declaration);
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of children(statement, 'specifiers')) {
      const local = child(specifier, 'local')?.name as string;
      if (specifier.type === 'ImportNamespaceSpecifier') names.namespaces.add(local);
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = child(specifier, 'imported');
      const name = imported?.type === 'Identifier' ? imported.name : imported?.value;
      if (typeof name !== 'string') continue;
      if (SOURCE_NAMES.has(name)) names.values.add(local);
      if (SOURCE_TYPES.has(name)) names.types.add(local);
    }
  }
  // A local `type X = InputDelivery` (or one built on another alias) names a source type too.
  const referenced = new Map(aliases.map(alias => [alias, typeNames(child(alias, 'typeAnnotation'))]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [alias, used] of referenced) {
      const name = child(alias, 'id')?.name as string;
      if (names.types.has(name) || !used.some(type => names.types.has(type))) continue;
      names.types.add(name);
      grew = true;
    }
  }
  return names;
}

/** Every type name a type annotation references. */
function typeNames(node: EsNode | undefined): string[] {
  const found: string[] = [];
  const visit = (current: EsNode) => {
    if (current.type === 'TSTypeReference') found.push(typeRefName(current) ?? '');
    eachChild(current, visit);
  };
  if (node) visit(node);
  return found;
}

/** The name a type reference uses: `T` or the right side of `ns.T`. */
function typeRefName(node: EsNode): string | undefined {
  const typeName = child(node, 'typeName');
  if (typeName?.type === 'Identifier') return typeName.name as string;
  return typeName?.type === 'TSQualifiedName' ? child(typeName, 'right')?.name as string | undefined : undefined;
}

/** A function. `path` holds its enclosing classes and functions; `name` is set at the end, when every repeat is known. */
interface Scope { node: EsNode; own: string | undefined; path: readonly (string | Scope)[]; name: string; source: boolean; facts: Set<string>; children: Scope[] }

/** A method signature with no body: an overload or an abstract method. It opens no scope. */
function declaredMethod(node: EsNode): boolean {
  return node.type === 'TSAbstractMethodDefinition' || (node.type === 'MethodDefinition' && child(node, 'value')?.type === 'TSEmptyBodyFunctionExpression');
}

const CLASS_FIELDS = new Set(['PropertyDefinition', 'TSAbstractPropertyDefinition']);

/** A function's own name: its id, its method key, or the binding or property that holds it. */
function ownName(node: EsNode): string | undefined {
  const id = child(node, 'id');
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && id) return id.name as string;
  const key = child(node, 'key');
  if (node.type === 'MethodDefinition' || node.type === 'Property') {
    if (key?.type === 'Identifier') return key.name as string;
    return key?.type === 'PrivateIdentifier' && node.type === 'MethodDefinition' ? `#${key.name as string}` : undefined;
  }
  const parent = node.parent;
  const held = parent?.type === 'VariableDeclarator' ? child(parent, 'id') : parent && ((parent.type === 'Property' && parent.method !== true) || CLASS_FIELDS.has(parent.type)) ? child(parent, 'key') : undefined;
  return held?.type === 'Identifier' ? held.name as string : undefined;
}

/**
 * The visitors that find qualifying functions in one file. Each function is a scope, opened when
 * oxlint enters it and closed when it leaves; a closed scope passes its reads to the one around it,
 * so an outer function counts its nested callbacks. Imports bind names only: `sourceNames` reads
 * them, so nothing inside an import counts.
 */
function combinationVisitors(keys: () => Set<string>): { visitors: Visitors; scopes(): Scope[] } {
  let names: Names = { values: new Set(), types: new Set(), namespaces: new Set() };
  const open: Scope[] = [];
  const roots: Scope[] = [];
  const path: (string | Scope)[] = [];
  const order = viewOrder<Scope>();
  let moduleSource = false;
  let imports = 0;
  const credit = (source: boolean, key: string | undefined) => {
    const scope = open.at(-1);
    if (!scope) { if (source) moduleSource = true; return; }
    if (source) scope.source = true;
    if (key !== undefined && keys().has(key)) scope.facts.add(key);
  };
  const keyRead = (key: string | undefined, namespaced = false) => {
    if (imports === 0) credit(namespaced || (key !== undefined && SOURCE_KEYS.has(key)), key);
  };
  const enter = (node: EsNode) => {
    if (imports > 0 || methodValue(node) || declaredMethod(node) || (node.type === 'Property' && node.method !== true)) return;
    const scope: Scope = { node, own: ownName(node), path: [...path], name: '', source: false, facts: new Set(), children: [] };
    (open.at(-1)?.children ?? roots).push(scope);
    order.add(scope);
    open.push(scope);
    path.push(scope);
  };
  const leave = (node: EsNode) => {
    const scope = open.at(-1);
    if (scope?.node !== node) return;
    open.pop();
    path.pop();
    const outer = open.at(-1);
    if (!outer) return;
    if (scope.source) outer.source = true;
    for (const fact of scope.facts) outer.facts.add(fact);
  };
  const enterClass = (node: EsNode) => {
    const parent = node.parent;
    const held = parent?.type === 'VariableDeclarator' && child(parent, 'id')?.type === 'Identifier' ? child(parent, 'id')!.name as string : '(anonymous class)';
    path.push((child(node, 'id')?.name as string | undefined) ?? held);
  };
  const identifier = (node: EsNode) => { if (imports === 0 && names.values.has(node.name as string)) credit(true, undefined); };
  const visitors: Visitors = {
    Program(node) { names = sourceNames(node); },
    ImportDeclaration() { imports++; },
    'ImportDeclaration:exit'() { imports--; },
    ClassDeclaration: enterClass,
    'ClassDeclaration:exit'() { path.pop(); },
    ClassExpression: enterClass,
    'ClassExpression:exit'() { path.pop(); },
    MemberExpression(node) {
      const key = staticKey(child(node, 'property'), node.computed === true);
      const object = field(node, 'object');
      keyRead(key, object?.type === 'Identifier' && names.namespaces.has(object.name as string) && key !== undefined && SOURCE_NAMES.has(key));
    },
    Property(node) {
      enter(node);
      if (node.parent?.type === 'ObjectPattern') keyRead(staticKey(child(node, 'key'), node.computed === true));
    },
    'Property:exit': leave,
    Identifier: identifier,
    // A private name reads as its identifier (`#RUNNER_FACTS`), as the rule always read it.
    PrivateIdentifier: identifier,
    TSTypeReference(node) {
      const name = typeRefName(node);
      if (imports === 0 && name !== undefined && names.types.has(name)) credit(true, undefined);
    },
  };
  for (const type of ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition']) {
    visitors[type] = enter;
    visitors[`${type}:exit`] = leave;
  }
  let named = false;
  return {
    visitors: order.wrap(visitors),
    scopes() {
      if (!named) { nameScopes(order.items()); named = true; }
      const found: Scope[] = [];
      const qualifying = (scope: Scope) => {
        if ((scope.source || moduleSource) && scope.facts.size >= 2) found.push(scope);
        for (const nested of scope.children) qualifying(nested);
      };
      for (const root of roots) qualifying(root);
      return found;
    },
  };
}

/**
 * Each function's name qualified by its enclosing classes and functions (`Runner>settle>inner`), so
 * an exception names one function. An unnamed function or a repeated name is numbered in `scopes`
 * order, which puts an enclosing function first.
 */
function nameScopes(scopes: readonly Scope[]): void {
  const seen = new Map<string, number>();
  for (const scope of scopes) {
    const segments = scope.path.map(entry => typeof entry === 'string' ? entry : entry.name.slice(entry.name.lastIndexOf('>') + 1));
    const base = [...segments, scope.own ?? '(anonymous function)'].join('>');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    scope.name = count === 1 ? base : `${base}#${count}`;
  }
}

export interface FactCombination { name: string; line: number; facts: string[] }

export function factCombinations(source: string, keys: Set<string> = FACT_KEYS()): FactCombination[] {
  // A cheap pre-filter: a fact source is spelled by one of these words, or reached through a module import.
  // oxlint-disable-next-line cez/regex-module-syntax -- a plain-text pre-filter; the AST pass below decides
  if (!/RUNNER_FACTS|\bfacts\b|inputDelivery|systemPromptOnResume|RunnerFacts|\bimport\b/i.test(source)) return [];
  const scan = combinationVisitors(() => keys);
  let found: Scope[] = [];
  scanSource('file.ts', source, () => ({ ...scan.visitors, 'Program:exit'() { found = scan.scopes(); } }));
  return found
    .map(scope => ({ name: scope.name, line: lineAt(source, scope.node.start as number), facts: [...scope.facts].sort() }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/**
 * A reported function the rule lets pass, as `<file>#<function>`. `reason` says why. A real
 * combination also names `row`, `<family> <row>`: a registered parity row that runs the combination
 * on every runner (`core/parity-classes.test.ts` checks it). A false positive, an unrelated object
 * with a same-named key, has no row.
 */
export interface CombinationException { readonly reason: string; readonly row?: string }

export const COMBINATION_ROWS: Readonly<Record<string, CombinationException>> = {};

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$/.test(file);

/** The rule's findings in one file, after the exceptions. */
export function combinationFindings(file: string, source: string, exceptions: Readonly<Record<string, CombinationException>> = COMBINATION_ROWS) {
  return factCombinations(source).filter(({ name }) => exceptions[`${file}#${name}`] === undefined).map(({ name, line, facts }) => ({
    line,
    message: `${name} touches a runner fact source and reads ${facts.join(' and ')}. Shared parity rows run on one runner and unit tests drive each other fact value once, not each combination: `
      + 'split the function so each part reads one fact, or add it to COMBINATION_ROWS with a reason and, for a real combination, a parity row that runs on every runner (hearsay-tools/cezarion#2991).',
  }));
}

export const runnerFactCombination: AstRule = {
  name: 'runner-fact-combination',
  description: 'A function above the runner seam that touches a fact source reads at most one declared runner fact key (hearsay-tools/cezarion#2991).',
  applies: file => /^packages\/cezar\/src\/workflows\/.+\.ts$/.test(file) && !isTest(file),
  create(report, { file }) {
    const scan = combinationVisitors(FACT_KEYS);
    return { ...scan.visitors, 'Program:exit'() {
    for (const scope of scan.scopes()) {
      if (COMBINATION_ROWS[`${file}#${scope.name}`] !== undefined) continue;
      report(reportNode(scope.node), `${scope.name} touches a runner fact source and reads ${[...scope.facts].sort().join(' and ')}. Shared parity rows run on one runner and unit tests drive each other fact value once, not each combination: `
        + 'split the function so each part reads one fact, or add it to COMBINATION_ROWS with a reason and, for a real combination, a parity row that runs on every runner (hearsay-tools/cezarion#2991).');
    }
    } };
  },
};
