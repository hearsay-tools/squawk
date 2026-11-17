import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './source-rule.ts';
import { child, children, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { bare, field, item, reportNode, scanSource } from './ast-tree.ts';

export const homeReadersFile = 'packages/cezar/src/lint/home-readers.baseline.json';
export interface HomeReader { file: string; kind: 'homedir'; calls: number; reason: string }
export interface HomeSite { kind: 'cezarHomeDir' | 'resolveHome' | 'homedir' | 'test-selection'; offset: number }
const ENTRY_POINTS = new Set(['packages/cezar/src/index.ts', 'packages/cezar/src/subcommands.ts']);
const SHARED_SETUP = 'packages/cezar/vitest.setup.ts';
const HOME_DIR = 'packages/cezar/src/home/';
export const TEST_FILE = /\.(?:test|testkit)\.[cm]?[jt]sx?$/;

export function readHomeReaders(path = join(repoRoot, homeReadersFile)): HomeReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HomeReader[] }).entries;
}

/** `node` without its type casts and chain, as the rule reads a value. `satisfies` stays. */
export function unwrapped(node: EsNode): EsNode {
  let current = node;
  while (UNWRAPPED.has(current.type)) {
    const inner = child(current, 'expression');
    if (!inner) break;
    current = inner;
  }
  return current;
}
const UNWRAPPED = new Set(['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);

/** A string, a plain template or a `+` of both, through casts. */
export function staticKey(node: EsNode | undefined): string | undefined {
  if (!node) return undefined;
  const target = unwrapped(node);
  if (target.type === 'Literal') return typeof target.value === 'string' ? target.value : undefined;
  if (target.type === 'TemplateLiteral') return stringOf(target);
  if (target.type === 'BinaryExpression' && target.operator === '+') {
    const left = staticKey(field(target, 'left'));
    const right = left === undefined ? undefined : staticKey(field(target, 'right'));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

/** An identifier's name, or the static text of any other node. */
export function name(node: EsNode | undefined): string | undefined {
  const target = bare(node);
  return target?.type === 'Identifier' ? target.name as string : staticKey(target);
}

/** A member's static property name, or `name` of any other node. */
export function property(node: EsNode | undefined): string | undefined {
  const target = bare(node);
  if (target?.type !== 'MemberExpression') return name(target);
  return target.computed ? staticKey(field(target, 'property')) : name(field(target, 'property'));
}

const isMember = (node: EsNode | undefined): node is EsNode => node?.type === 'MemberExpression';

/** The identifier a reference ends at without a match yet: an alias declared later can still match it. */
let unresolved: string | undefined;

function homedirRef(node: EsNode | undefined, aliases: Set<string>): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'SequenceExpression') return homedirRef(item(target, 'expressions', -1), aliases);
  if (target.type === 'Identifier') {
    if (aliases.has(target.name as string)) return true;
    unresolved = target.name as string;
    return false;
  }
  if (target.type === 'CallExpression') {
    const callee = unwrapped(field(target, 'callee')!);
    return isMember(callee) && property(callee) === 'bind' && homedirRef(field(callee, 'object'), aliases);
  }
  if (!isMember(target)) return false;
  const member = property(target);
  return member === 'homedir' || ((member === 'call' || member === 'apply') && homedirRef(field(target, 'object'), aliases));
}

function callsHomedir(node: EsNode, aliases: Set<string>): boolean {
  const callee = unwrapped(field(node, 'callee')!);
  if (isMember(callee) && property(callee) === 'apply' && name(field(callee, 'object')) === 'Reflect') return homedirRef(item(node, 'arguments', 0), aliases);
  return homedirRef(callee, aliases);
}

function processEnv(node: EsNode | undefined): boolean {
  if (!node) return false;
  const env = unwrapped(node);
  return isMember(env) && property(env) === 'env' && name(unwrapped(field(env, 'object')!)) === 'process';
}

function homeWriteTarget(node: EsNode | undefined): boolean {
  if (!node) return false;
  const target = unwrapped(node);
  if (target.type === 'ArrayPattern') return children(target, 'elements').some(homeWriteTarget);
  if (target.type === 'ObjectPattern') return children(target, 'properties').some(entry => {
    return homeWriteTarget(field(entry, entry.type === 'RestElement' ? 'argument' : 'value'));
  });
  if (target.type === 'AssignmentPattern') return homeWriteTarget(field(target, 'left'));
  if (target.type === 'RestElement') return homeWriteTarget(field(target, 'argument'));
  return isMember(target) && property(target) === 'CEZ_HOME' && processEnv(field(target, 'object'));
}

function homeProperty(node: EsNode): boolean {
  const source = unwrapped(node);
  return source.type === 'ObjectExpression' && children(source, 'properties').some(entry => {
    return entry.type === 'Property' && (entry.computed ? staticKey(field(entry, 'key')) : name(field(entry, 'key'))) === 'CEZ_HOME';
  });
}

function selectsHomeCall(node: EsNode): boolean {
  const callee = unwrapped(field(node, 'callee')!);
  const method = property(callee);
  const args = children(node, 'arguments');
  if (method === 'stubEnv') return staticKey(bare(args[0])) === 'CEZ_HOME';
  if (!isMember(callee)) return false;
  if (!processEnv(bare(args[0]))) return false;
  const owner = name(unwrapped(field(callee, 'object')!));
  if (owner === 'Object' && method === 'assign') return args.slice(1).some(arg => homeProperty(bare(arg)!));
  return ['Reflect.set', 'Reflect.defineProperty', 'Object.defineProperty'].includes(`${owner}.${method}`)
    && staticKey(bare(args[1])) === 'CEZ_HOME';
}

type Site = HomeSite & { node: EsNode; order: number };

/**
 * The visitors that find home sites in one file, and the sites they found, in source order. With
 * `selectionsOnly`, only test home selections: a test file reports nothing else.
 */
function homeSiteVisitors(selectionsOnly: boolean): { visitors: Visitors; sites(): Site[] } {
  const aliases = new Set(['homedir']);
  const found: Site[] = [];
  // A call whose callee ends at a name that is no alias yet: an alias declared later still counts.
  const pending: { node: EsNode; alias: string; order: number }[] = [];
  let order = 0;
  const add = (kind: HomeSite['kind'], node: EsNode) => found.push({ kind, offset: node.start as number, node, order: order++ });
  const selection = (node: EsNode) => {
    order++;
    const target = node.type === 'UpdateExpression' || node.type === 'UnaryExpression' ? 'argument' : 'left';
    if (node.type === 'UnaryExpression' && node.operator !== 'delete') return;
    if (homeWriteTarget(field(node, target))) add('test-selection', node);
  };
  const named = (node: EsNode) => {
    if (node.name === 'cezarHomeDir' || node.name === 'resolveHome') add(node.name, node);
  };
  const visitors: Visitors = {
    AssignmentExpression: selection,
    ForInStatement: selection,
    ForOfStatement: selection,
    UpdateExpression: selection,
    UnaryExpression: selection,
    CallExpression(node) {
      order++;
      if (!selectionsOnly) {
        unresolved = undefined;
        if (callsHomedir(node, aliases)) add('homedir', node);
        else if (unresolved !== undefined) pending.push({ node, alias: unresolved, order: order++ });
      }
      if (selectsHomeCall(node)) add('test-selection', node);
    },
  };
  if (selectionsOnly) return { visitors, sites: () => found };
  return {
    visitors: {
      ...visitors,
      Identifier: named,
      // A private name reads as its identifier (`#resolveHome`), as the rule always read it.
      PrivateIdentifier: named,
      MemberExpression(node) {
        if (!node.computed) return;
        const member = property(node);
        if (member === 'cezarHomeDir' || member === 'resolveHome') add(member, node);
      },
      ImportSpecifier(node) {
        if (name(field(node, 'imported')) === 'homedir') aliases.add(field(node, 'local')!.name as string);
      },
      VariableDeclarator(node) {
        const id = field(node, 'id')!;
        if (id.type === 'ObjectPattern') {
          for (const entry of children(id, 'properties')) {
            const value = field(entry, 'value');
            if (entry.type === 'Property' && name(field(entry, 'key')) === 'homedir' && value?.type === 'Identifier') aliases.add(value.name as string);
          }
        }
        if (id.type === 'Identifier' && homedirRef(field(node, 'init'), aliases)) aliases.add(id.name as string);
      },
    },
    sites() {
      for (const call of pending) if (aliases.has(call.alias)) found.push({ kind: 'homedir', offset: call.node.start as number, node: call.node, order: call.order });
      return found.sort((a, b) => a.offset - b.offset || a.order - b.order);
    },
  };
}

/** Parse failures propagate to lint. Strings and comments cannot hide or create sites. */
export function homeSites(source: string, file = 'file.ts'): HomeSite[] {
  return homeSiteNodes(source, file).map(({ kind, offset }) => ({ kind, offset }));
}

function homeSiteNodes(source: string, file: string): Site[] {
  const scan = homeSiteVisitors(false);
  scanSource(file, source, () => scan.visitors);
  return scan.sites();
}

function testFile(file: string): boolean { return TEST_FILE.test(file) || file.startsWith('packages/cezar/test/'); }
function productFile(file: string): boolean { return file.startsWith('packages/cezar/src/') && !testFile(file); }

let readers: HomeReader[] | undefined;
export function scanHomeBoundary(file: string, source: string, exemptions = (readers ??= readHomeReaders())): HomeSite[] {
  return homeBoundarySites(file, homeSites(source, file), exemptions);
}

function homeBoundarySites<T extends HomeSite>(file: string, sites: T[], exemptions: HomeReader[]): T[] {
  if (testFile(file)) return sites.filter(site => site.kind === 'test-selection');
  if (!productFile(file)) return [];
  const allowed = exemptions.find(entry => entry.file === file)?.calls ?? 0;
  let calls = 0;
  return sites.filter(site => {
    if (site.kind === 'cezarHomeDir') return true;
    if (site.kind === 'resolveHome') return !file.startsWith(HOME_DIR) && !ENTRY_POINTS.has(file);
    if (site.kind === 'homedir') return ++calls > allowed && !file.startsWith(HOME_DIR);
    return false;
  });
}

/** Counts must still name actual calls. CI's baseline-growth gate permits only shrinking entries. */
export function staleHomeReaders(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readHomeReaders(join(root, homeReadersFile)).flatMap(entry => {
    const path = join(root, entry.file);
    const count = existsSync(path) ? homeSites(readFileSync(path, 'utf8'), entry.file).filter(site => site.kind === 'homedir').length : 0;
    const valid = productFile(entry.file) && !entry.file.startsWith(HOME_DIR) && entry.kind === 'homedir'
      && entry.reason.trim() && Number.isInteger(entry.calls) && entry.calls > 0 && !seen.has(entry.file);
    seen.add(entry.file);
    return valid && count >= entry.calls ? [] : [`${homeReadersFile} cez/home-boundary: stale or invalid entry ${entry.file}; remove or lower the exemption (hearsay-tools/cezarion#2810).`];
  });
}

export const homeBoundaryMessage = (kind: HomeSite['kind']): string => `${kind}: pass an explicit Home from an entry point; tests select Home.sandbox through shared setup. OS-user readers belong to shrink-only home-readers.baseline.json (hearsay-tools/cezarion#2810).`;

export const homeBoundary: AstRule = {
  name: 'home-boundary',
  description: 'Resolve cockpit homes at entry points; tests select Home.sandbox (hearsay-tools/cezarion#2810).',
  applies: file => file !== SHARED_SETUP && (TEST_FILE.test(file) || /^packages\/cezar\/(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(file)),
  create(report, { file }) {
    const scan = homeSiteVisitors(testFile(file));
    return {
      ...scan.visitors,
      'Program:exit'() {
        const sites = scan.sites();
        if (sites.length === 0) return;
        for (const site of homeBoundarySites(file, sites, readers ??= readHomeReaders())) report(reportNode(site.node), homeBoundaryMessage(site.kind));
      },
    };
  },
};
