import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { property, unwrapped } from './home-boundary.ts';
import { repoRoot } from './source-rule.ts';
import { child, children, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { eachChild, field, item, reportNode, scanSource } from './ast-tree.ts';
import { productEnvSuffix, scannedEnvFile } from './undocumented-env-name.ts';

export const productEnvBaselineFile = 'packages/cezar/src/lint/product-env-read.baseline.json';
const ACCESSOR = 'packages/cezar/src/core/product-env.ts';
export interface EnvRead { form: 'dot' | 'bracket' | 'computed' | 'destructure' | 'helper-dynamic'; name: string; offset: number; expression?: string }
export interface EnvReadAllowance { file: string; form: EnvRead['form']; name: string; reads: number }

export const productEnvFile = (file: string): boolean => file !== ACCESSOR && scannedEnvFile(file);
export function readProductEnvBaseline(path = join(repoRoot, productEnvBaselineFile)): EnvReadAllowance[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: EnvReadAllowance[] }).entries;
}

const productName = (name: string | undefined): boolean => /^(CEZ|HSQ)_[A-Z0-9_]+$/.test(name ?? '');

type EnvReference = 'global' | 'process' | 'env';
type EnvBindings = Map<string, EnvReference>;
type TypeAliases = Map<string, EsNode>;
type Site = EnvRead & { node: EsNode };
const OBJECT_UTILITIES = new Set(['Partial', 'Readonly', 'Required', 'Pick', 'Omit', 'NonNullable']);
/** Every node type with a `params` list that can bind or read an env pattern. */
const FUNCTION_TYPES = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'TSDeclareFunction', 'TSEmptyBodyFunctionExpression',
  'TSFunctionType', 'TSConstructorType', 'TSMethodSignature', 'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration'];

function childReference(owner: EnvReference | undefined, key: string | undefined): EnvReference | undefined {
  if (owner === 'global' && key === 'process') return 'process';
  // As with member reads, an env property is conservatively treated as an env source.
  if (key === 'env') return 'env';
  return undefined;
}

function reference(node: EsNode | undefined, aliases: EnvBindings): EnvReference | undefined {
  if (!node) return undefined;
  const target = unwrapped(node);
  if (target.type === 'Identifier') {
    const name = target.name as string;
    if (aliases.has(name)) return aliases.get(name);
    if (name === 'process') return 'process';
    if (name === 'globalThis') return 'global';
    if (/env$/i.test(name)) return 'env';
  }
  if (target.type === 'TSQualifiedName') return childReference(reference(field(target, 'left'), aliases), field(target, 'right')?.name as string | undefined);
  if (target.type === 'MemberExpression') return childReference(reference(field(target, 'object'), aliases), property(target));
  return undefined;
}

/** Resolve only object-preserving type forms, without requiring the TypeScript checker. */
function typeReference(type: EsNode | undefined, aliases: TypeAliases, parameters = new Map<string, EnvReference | undefined>(), seen = new Set<EsNode>()): EnvReference | undefined {
  if (!type || seen.has(type)) return undefined;
  const next = new Set(seen).add(type);
  if (type.type === 'TSTypeReference') return namedTypeReference(type, aliases, parameters, next);
  if (type.type === 'TSTypeQuery') return reference(field(type, 'exprName'), new Map());
  if (type.type === 'TSParenthesizedType') return typeReference(child(type, 'typeAnnotation'), aliases, parameters, next);
  if (type.type === 'TSUnionType' || type.type === 'TSIntersectionType') {
    const refs = children(type, 'types').map(part => typeReference(part, aliases, parameters, next));
    return refs.find(ref => ref === 'env') ?? refs.find(ref => ref !== undefined);
  }
  if (type.type === 'TSIndexedAccessType') {
    const owner = typeReference(child(type, 'objectType'), aliases, parameters, next);
    const index = child(type, 'indexType');
    const key = index?.type === 'TSLiteralType' ? property(child(index, 'literal')) : undefined;
    return owner === undefined ? undefined : childReference(owner, key);
  }
  // Arrays, tuples, keyof and scalar types do not describe an env object.
  return undefined;
}

function namedTypeReference(type: EsNode, aliases: TypeAliases, parameters: Map<string, EnvReference | undefined>, seen: Set<EsNode>): EnvReference | undefined {
  const typeName = child(type, 'typeName');
  const name = property(typeName?.type === 'TSQualifiedName' ? child(typeName, 'right') : typeName)!;
  if (parameters.has(name)) return parameters.get(name);
  if (name === 'ProcessEnv') return 'env';
  if (name === 'Process') return 'process';
  const typeArguments = paramsOf(child(type, 'typeArguments'));
  if (OBJECT_UTILITIES.has(name)) return typeReference(typeArguments[0], aliases, parameters, seen);
  const alias = aliases.get(name);
  if (!alias) return undefined;
  const substitutions = new Map(parameters);
  for (const [index, parameter] of paramsOf(child(alias, 'typeParameters')).entries()) {
    const argument = typeArguments[index];
    substitutions.set(child(parameter, 'name')?.name as string, argument
      ? typeReference(argument, aliases, parameters, seen)
      : typeReference(child(parameter, 'default'), aliases, substitutions, seen));
  }
  return typeReference(child(alias, 'typeAnnotation'), aliases, substitutions, seen);
}
/** The `params` of a type parameter or type argument list, if there is one. */
const paramsOf = (list: EsNode | undefined): readonly EsNode[] => list ? children(list, 'params') : [];

function typedReference(node: EsNode | undefined, aliases: TypeAliases): EnvReference | undefined {
  const annotation = node && child(node, 'typeAnnotation');
  if (annotation?.type !== 'TSTypeAnnotation') return undefined;
  return typeReference(child(annotation, 'typeAnnotation'), aliases);
}

/** Walk the pattern with its source, including defaults and copies made by rest bindings. */
function patternReads(pattern: EsNode | undefined, owner: EnvReference | undefined, aliases: EnvBindings, bind: boolean): Site[] {
  if (!pattern) return [];
  if (pattern.type === 'AssignmentPattern') return patternReads(field(pattern, 'left'), owner ?? reference(field(pattern, 'right'), aliases), aliases, bind);
  if (pattern.type === 'Identifier') {
    if (bind && owner) aliases.set(pattern.name as string, owner);
    return [];
  }
  if (pattern.type !== 'ObjectPattern') return [];
  return children(pattern, 'properties').flatMap(entry => {
    if (entry.type === 'RestElement') {
      const reads: Site[] = owner === 'env' ? [{ form: 'computed', name: '*', offset: entry.start as number, node: entry }] : [];
      return [...reads, ...patternReads(field(entry, 'argument'), owner, aliases, bind)];
    }
    const key = field(entry, 'key');
    const name = entry.computed && key?.type === 'Identifier' ? undefined : property(key);
    const reads: Site[] = (owner === 'env' && productName(name)) || (owner !== undefined && name === undefined)
      ? [{ form: name === undefined ? 'computed' : 'destructure', name: name ?? '*', offset: entry.start as number, node: entry }] : [];
    return [...reads, ...patternReads(field(entry, 'value'), childReference(owner, name), aliases, bind)];
  });
}

function bindingReads(node: EsNode, aliases: EnvBindings, types: TypeAliases, bind: boolean): Site[] {
  if (node.type === 'Identifier') {
    const typed = typedReference(node, types);
    if (bind && typed) aliases.set(node.name as string, typed);
    return [];
  }
  if (node.type === 'VariableDeclarator') {
    const id = field(node, 'id');
    return patternReads(id, typedReference(id, types) ?? reference(field(node, 'init'), aliases), aliases, bind);
  }
  if (node.type === 'AssignmentExpression') return patternReads(field(node, 'left'), reference(field(node, 'right'), aliases), aliases, bind);
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') return patternReads(field(node, 'left'), undefined, aliases, bind);
  return children(node, 'params').flatMap(param => {
    const pattern = param.type === 'AssignmentPattern' ? field(param, 'left') : param;
    return patternReads(param, typedReference(pattern, types), aliases, bind);
  });
}

/** Whether `value` can name an env, process or global object, whatever the aliases turn out to be. */
function mayReference(value: EsNode | undefined): boolean {
  const target = value && unwrapped(value);
  if (target?.type === 'Identifier') return true;
  if (target?.type !== 'MemberExpression') return false;
  const key = property(target);
  return key === 'env' || key === 'process';
}

const plainName = (node: EsNode | undefined): boolean => node?.type === 'Identifier' && !node.typeAnnotation;

/** Whether a binding node can bind an alias or read an env pattern; most cannot, and are not kept. */
function bindingMatters(node: EsNode): boolean {
  if (node.type === 'Identifier') return child(node, 'typeAnnotation')?.type === 'TSTypeAnnotation';
  if (node.type === 'VariableDeclarator') return !plainName(field(node, 'id')) || mayReference(field(node, 'init'));
  if (node.type === 'AssignmentExpression') {
    const left = field(node, 'left');
    return left?.type !== 'MemberExpression' && (!plainName(left) || mayReference(field(node, 'right')));
  }
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    const left = field(node, 'left');
    return left?.type !== 'VariableDeclaration' && left?.type !== 'MemberExpression' && !plainName(left);
  }
  return children(node, 'params').some(param => !plainName(param));
}

function markWriteTarget(node: EsNode | undefined, targets: Set<EsNode>): void {
  if (!node) return;
  const target = unwrapped(node);
  if (target.type === 'MemberExpression') { targets.add(target); return; }
  if (target.type === 'ObjectPattern') {
    for (const entry of children(target, 'properties')) markWriteTarget(field(entry, entry.type === 'RestElement' ? 'argument' : 'value'), targets);
  }
  if (target.type === 'ArrayPattern') for (const element of children(target, 'elements')) markWriteTarget(element, targets);
  if (target.type === 'AssignmentPattern') markWriteTarget(field(target, 'left'), targets);
  if (target.type === 'RestElement') markWriteTarget(field(target, 'argument'), targets);
}

/** Only immutable literal strings can identify a computed environment key. */
function literalEnvKey(node: EsNode, bindings: Map<string, EsNode>, seen = new Set<string>()): string | undefined {
  const target = unwrapped(node);
  if (target.type === 'Literal') return typeof target.value === 'string' ? target.value : undefined;
  if (target.type === 'TemplateLiteral') return stringOf(target);
  if (target.type !== 'Identifier' || seen.has(target.name as string)) return undefined;
  const bound = bindings.get(target.name as string);
  return bound ? literalEnvKey(bound, bindings, new Set(seen).add(target.name as string)) : undefined;
}

/**
 * How often each of `names` is declared, as the rule counts it: every identifier inside a declared
 * pattern, parameter, catch parameter, import name or function and class name. A file needs it
 * only when a computed env read names a `const` key, so this walk is rare.
 */
function declarationCounts(program: EsNode, names: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  const count = (node: EsNode | undefined): void => {
    if (!node) return;
    if ((node.type === 'Identifier' || node.type === 'PrivateIdentifier') && names.has(node.name as string)) counts.set(node.name as string, (counts.get(node.name as string) ?? 0) + 1);
    eachChild(node, count);
  };
  const walk = (node: EsNode): void => {
    if (node.type === 'VariableDeclaration') for (const declaration of children(node, 'declarations')) count(child(declaration, 'id'));
    for (const param of children(node, 'params')) count(param);
    if (node.type === 'CatchClause') count(child(node, 'param'));
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') count(child(node, 'local'));
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'FunctionExpression') count(child(node, 'id'));
    eachChild(node, walk);
  };
  walk(program);
  return counts;
}

/** Each `const` name bound to a literal key, unless another declaration shadows or repeats it. */
function staticEnvNames(constants: Map<string, EsNode>, counts: Map<string, number>): Map<string, string> {
  for (const name of constants.keys()) if (counts.get(name) !== 1) constants.delete(name);
  const names = new Map<string, string>();
  for (const [name, value] of constants) {
    const literal = literalEnvKey(value, constants);
    if (literal !== undefined) names.set(name, literal);
  }
  return names;
}

/** `productEnv` and the names the file imports it under, in any module block. */
function productEnvHelpers(program: EsNode): Set<string> {
  const helpers = new Set(['productEnv']);
  const statements = (block: EsNode): void => {
    for (const entry of children(block, 'body')) {
      const statement = entry.type === 'ExportNamedDeclaration' ? child(entry, 'declaration') ?? entry : entry;
      if (statement.type === 'ImportDeclaration') {
        for (const specifier of children(statement, 'specifiers')) {
          if (specifier.type === 'ImportSpecifier' && property(field(specifier, 'imported')) === 'productEnv') helpers.add(field(specifier, 'local')!.name as string);
        }
      }
      let body = statement.type === 'TSModuleDeclaration' ? child(statement, 'body') : undefined;
      while (body?.type === 'TSModuleDeclaration') body = child(body, 'body');
      if (body) statements(body);
    }
  };
  statements(program);
  return helpers;
}

/**
 * The visitors that find env reads in one file, and the reads they found, in source order. Facts
 * that need the whole file (type aliases, env aliases, `const` keys) are collected as oxlint walks
 * and decided at the end: first the env aliases, which need every type alias, then the reads.
 */
function envReadVisitors(source: string): { visitors: Visitors; reads(program: EsNode): Site[] } {
  const types: TypeAliases = new Map();
  const constants = new Map<string, EsNode>();
  const writes = new Set<EsNode>();
  let helpers = new Set<string>();
  const sites: (Site & { order: number })[] = [];
  const dynamicCalls: (Site & { order: number })[] = [];
  // Binding nodes and computed reads whose answer depends on facts later in the file, in walk order.
  const deferred: { node: EsNode; order: number }[] = [];
  let order = 0;
  const binding = (node: EsNode) => {
    order++;
    if (bindingMatters(node)) deferred.push({ node, order });
  };
  const write = (node: EsNode) => {
    if (node.type === 'AssignmentExpression' ? node.operator === '=' : node.type !== 'UnaryExpression' || node.operator === 'delete') {
      markWriteTarget(field(node, node.type === 'UnaryExpression' ? 'argument' : 'left'), writes);
    }
  };
  const visitors: Visitors = {
    Program(node) { helpers = productEnvHelpers(node); },
    TSTypeAliasDeclaration(node) { types.set(field(node, 'id')!.name as string, node); },
    VariableDeclaration(node) {
      if (node.kind !== 'const') return;
      for (const declaration of children(node, 'declarations')) {
        const id = field(declaration, 'id');
        const init = child(declaration, 'init');
        if (id?.type === 'Identifier' && init) constants.set(id.name as string, init);
      }
    },
    Identifier: binding,
    VariableDeclarator: binding,
    AssignmentExpression(node) { write(node); binding(node); },
    ForOfStatement(node) { write(node); binding(node); },
    ForInStatement(node) { write(node); binding(node); },
    UnaryExpression: write,
    MemberExpression(node) {
      order++;
      if (writes.has(node)) return;
      const name = property(node);
      if (name === undefined && node.computed) deferred.push({ node, order });
      else if (productName(name)) sites.push(memberSite(node, name, source, order));
    },
    CallExpression(node) {
      order++;
      if (!helpers.has(property(unwrapped(field(node, 'callee')!)) ?? '')) return;
      if (productEnvSuffix(item(node, 'arguments', 0)) === undefined) dynamicCalls.push({ form: 'helper-dynamic', name: '*', offset: node.start as number, node, order });
    },
  };
  for (const type of FUNCTION_TYPES) visitors[type] = binding;
  return {
    visitors,
    reads(program) {
      const aliases: EnvBindings = new Map();
      for (const { node } of deferred) if (node.type !== 'MemberExpression') bindingReads(node, aliases, types, true);
      const staticNames = deferred.some(({ node }) => node.type === 'MemberExpression' && namesConstant(node, constants, aliases))
        ? staticEnvNames(constants, declarationCounts(program, new Set(constants.keys()))) : new Map<string, string>();
      for (const { node, order: at } of deferred) {
        if (node.type !== 'MemberExpression') { for (const site of bindingReads(node, aliases, types, false)) sites.push({ ...site, order: at }); continue; }
        const key = field(node, 'property')!;
        const name = key.type === 'Identifier' ? staticNames.get(key.name as string) : undefined;
        if (productName(name) || (name === undefined && reference(field(node, 'object'), aliases) === 'env')) sites.push(memberSite(node, name, source, at));
      }
      const ordered = sites.sort((a, b) => a.order - b.order);
      return [...ordered, ...dynamicCalls.sort((a, b) => a.order - b.order)].sort((a, b) => a.offset - b.offset);
    },
  };
}

function memberSite(node: EsNode, name: string | undefined, source: string, order: number): Site & { order: number } {
  const offset = node.start as number;
  return { form: node.computed ? name === undefined ? 'computed' : 'bracket' : 'dot', name: name ?? '*', offset, expression: source.slice(offset, node.end as number), node, order };
}

/** Whether a computed read's key is a `const` name whose literal key could change its finding. */
function namesConstant(node: EsNode, constants: Map<string, EsNode>, aliases: EnvBindings): boolean {
  const key = field(node, 'property')!;
  const value = key.type === 'Identifier' ? constants.get(key.name as string) : undefined;
  const literal = value && literalEnvKey(value, constants);
  return literal !== undefined && (productName(literal) || reference(field(node, 'object'), aliases) === 'env');
}

/** AST scanning avoids strings/comments, supports env arguments, brackets, aliases and destructuring. */
export function productEnvReads(source: string, file = 'file.ts'): EnvRead[] {
  const scan = envReadVisitors(source);
  let reads: Site[] = [];
  scanSource(file, source, () => ({ ...scan.visitors, 'Program:exit'(program) { reads = scan.reads(program); } }));
  return reads.map(({ form, name, offset, expression }) => ({ form, name, offset, ...(expression === undefined ? {} : { expression }) }));
}

/** Permanent non-setting reads, separate from the migration baseline. Exact expressions
 * keep new indexing sites visible; named product settings can never use this exemption. */
export const nonSettingEnvReads = [
  { file: 'packages/cezar/src/ci-wait/tool-catalog.ts', form: 'computed', expression: 'env[preferred]', reason: 'Include a defined preferred controller entry in native adapter allowlists, including clears.' },
  { file: 'packages/cezar/src/core/agent-env.ts', form: 'computed', expression: 'source[name]', reason: 'Generic case-insensitive Bedrock/Vertex third-party toggle lookup.' },
  { file: 'packages/cezar/src/home/kind-roots.ts', form: 'computed', expression: 'env[name]', reason: 'XDG kind-root lookup; not a product setting.' },
  { file: 'packages/cezar/src/home/resolve.ts', form: 'computed', expression: 'env[name]', reason: 'Project HOME_LAYOUT_ENV OS/XDG roots into the layout resolver.' },
  { file: 'packages/cezar/scripts/benchmark-workspace-events.ts', form: 'computed', expression: 'process.env[name]', reason: 'Snapshot exact names for sandbox restoration, without prefix precedence.' },
  { file: 'packages/cezar/scripts/benchmark-workspace-events.ts', form: 'computed', expression: 'savedEnv[name]', reason: 'Restore the original sandbox environment snapshot.' },
  { file: 'packages/cezar/scripts/mock-ci-tool.mjs', form: 'computed', expression: 'process.env[name]', reason: 'Native fixture MCP environment interpolation and allowlist forwarding.' },
  { file: 'packages/cezar/scripts/mock-env-record.mjs', form: 'computed', expression: 'process.env[name]', reason: 'Fixture records exact configured environment names.' },
] as const;

export const mockEnvReadExemption = {
  path: /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/,
  name: /^CEZ_MOCK_[A-Z0-9_]+$/,
  reason: 'Native mock controls are test fixtures, never operator product settings.',
};

export function nonSettingEnvRead(file: string, site: EnvRead): boolean {
  if (mockEnvReadExemption.path.test(file) && mockEnvReadExemption.name.test(site.name)) return true;
  // Only anonymous computed transport/lookups qualify. A literal product name never does.
  return site.name === '*' && site.form === 'computed' && nonSettingEnvReads.some(entry =>
    entry.file === file && entry.form === site.form && entry.expression === site.expression);
}

const key = (site: Pick<EnvRead, 'form' | 'name'>) => `${site.form}:${site.name}`;
let baseline: EnvReadAllowance[] | undefined;
export function scanProductEnvReads(file: string, source: string, allowances = (baseline ??= readProductEnvBaseline())): EnvRead[] {
  if (!productEnvFile(file)) return [];
  return unallowedEnvReads(file, productEnvReads(source, file), allowances);
}

function unallowedEnvReads<T extends EnvRead>(file: string, reads: T[], allowances: EnvReadAllowance[]): T[] {
  const counts = new Map(allowances.filter(entry => entry.file === file).map(entry => [key(entry), entry.reads]));
  return reads.filter(site => !nonSettingEnvRead(file, site)).filter(site => {
    const remaining = counts.get(key(site)) ?? 0;
    counts.set(key(site), remaining - 1);
    return remaining <= 0;
  });
}

/** Entries only shrink; CI checks growth against the committed baseline at the merge base. */
export function staleProductEnvReads(root = repoRoot): string[] {
  const entries = readProductEnvBaseline(join(root, productEnvBaselineFile));
  const sources = new Map<string, EnvRead[]>();
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    if (!sources.has(entry.file)) {
      const path = join(root, entry.file);
      sources.set(entry.file, existsSync(path) ? productEnvReads(readFileSync(path, 'utf8'), entry.file) : []);
    }
    const count = sources.get(entry.file)!.filter(site => key(site) === key(entry)).length;
    const id = `${entry.file}:${key(entry)}`;
    const valid = productEnvFile(entry.file) && Number.isInteger(entry.reads) && entry.reads > 0 && !seen.has(id) && count >= entry.reads;
    seen.add(id);
    return valid ? [] : [`${productEnvBaselineFile}: stale or invalid ${id}; remove or lower the entry. Never increase allowances.`];
  });
}

export const productEnvRead: AstRule = {
  name: 'product-env-read',
  description: 'Read product settings through core/product-env.ts; remaining shipped reads use a shrink-only inventory.',
  applies: productEnvFile,
  create(report, { file, sourceCode }) {
    const scan = envReadVisitors(sourceCode.text);
    return {
      ...scan.visitors,
      'Program:exit'(program) {
        const sites = scan.reads(program);
        if (sites.length === 0) return;
        for (const site of unallowedEnvReads(file, sites, baseline ??= readProductEnvBaseline())) {
          report(reportNode(site.node), `${site.form} ${site.name}: use productEnv with a literal suffix or the dedicated home accessor. Never add an allowance to product-env-read.baseline.json (hearsay-tools/cezarion#2970).`);
        }
      },
    };
  },
};
