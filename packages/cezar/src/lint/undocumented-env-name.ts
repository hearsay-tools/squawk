import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { property, unwrapped, visit } from './home-boundary.ts';
import { repoRoot } from './source-rule.ts';
import { child, nameOf, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { staticNodeText } from './ast-node-view.ts';

/**
 * `.env.example` is the env contract (AGENTS.md § Zero config): every `CEZ_*` or `HSQ_*` name a shipped source
 * or runner script reads or writes is documented there. This proves documentation coverage, not
 * correct default behavior.
 */
const SCANNED = ['packages/cezar/src/', 'packages/contract/src/', 'packages/api-client/src/', 'packages/web/src/', 'packages/cezar/scripts/'];
export const envExamplePath = join(repoRoot, '.env.example');

/**
 * Each `CEZ_*` or `HSQ_*` name in `source`, with the offset of its first occurrence. A conservative source scan,
 * not data-flow analysis. Match identifier nodes and complete literal values; examples inside
 * longer strings and comments are not environment names.
 */
function envSites(source: string, file = 'file.ts'): Map<string, number> {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])] });
  return envSitesFromAst(ast);
}

function envSitesFromAst(ast: Node): Map<string, number> {
  const names = new Map<string, number>();
  const add = (name: string, at: number) => {
    if (!names.has(name) || names.get(name)! > at) names.set(name, at);
  };
  visit(ast, node => {
    const name = node.type === 'Identifier' || node.type === 'JSXIdentifier' ? node.name
      : node.type === 'StringLiteral' || node.type === 'DirectiveLiteral' ? node.value
      : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined;
    if (name && /^(?:CEZ|HSQ)_[A-Z0-9_]+$/.test(name)) add(name, node.start ?? 0);
  });
  for (const call of productEnvCalls(ast)) {
    if (call.suffix === undefined) continue;
    for (const prefix of ['HSQ_', 'CEZ_']) add(`${prefix}${call.suffix}`, call.offset);
  }
  return names;
}

/** Named-import aliases retain the same env contract as productEnv. */
function productEnvHelpers(ast: Node): Set<string> {
  const names = new Set(['productEnv']);
  visit(ast, node => {
    if (node.type === 'ImportSpecifier' && property(node.imported) === 'productEnv') names.add(node.local.name);
  });
  return names;
}

/** Only a literal suffix can prove both accepted full names; dynamic calls fail read lint. */
export function productEnvCalls(ast: Node): { suffix: string | undefined; offset: number }[] {
  const helpers = productEnvHelpers(ast);
  const calls: { suffix: string | undefined; offset: number }[] = [];
  visit(ast, node => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    if (!helpers.has(property(unwrapped(node.callee)) ?? '')) return;
    const argument = node.arguments[0];
    const literal = argument && unwrapped(argument);
    const suffix = literal?.type === 'StringLiteral' ? literal.value
      : literal?.type === 'TemplateLiteral' && literal.expressions.length === 0 ? literal.quasis[0]?.value.cooked : undefined;
    calls.push({ suffix: suffix != null && /^[A-Z][A-Z0-9_]*$/.test(suffix) ? suffix : undefined, offset: node.start ?? 0 });
  });
  return calls;
}

export const envNames = (source: string): string[] => [...envSites(source).keys()].sort();

/** The names `source` uses that `documented` lacks. CEZ_MOCK_* controls offline test fault
 *  injection, not shipped settings, so the whole prefix is exempt. */
export const undocumented = (source: string, documented: Set<string>): string[] =>
  envNames(source).filter((name) => !name.startsWith('CEZ_MOCK_') && !documented.has(name));

export const documentedNames = (path = envExamplePath): Set<string> =>
  new Set(readFileSync(path, 'utf8').match(/\b(?:CEZ|HSQ)_[A-Z0-9_]+\b/g));

/** Whether the rule reads `file`: shipped sources and runner scripts, never tests or fixtures. */
export const scannedEnvFile = (file: string): boolean =>
  SCANNED.some((dir) => file.startsWith(dir)) &&
  /\.(?:[cm]?[jt]sx?)$/.test(file) &&
  !/\.(?:test|testkit|spec)\./.test(file.slice(file.lastIndexOf('/') + 1)) &&
  !/\/(?:__tests__|__fixtures__|fixtures)\//.test(file);

let documented: Set<string> | undefined;

function nativeUnwrapped(node: EsNode | undefined): EsNode | undefined {
  if (node && ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(node.type)) return nativeUnwrapped(child(node, 'expression'));
  return node;
}

function nativeProperty(node: EsNode | undefined): string | undefined {
  const target = nativeUnwrapped(node);
  if (target?.type !== 'MemberExpression') return nameOf(target) ?? stringOf(target);
  const key = child(target, 'property');
  return target.computed ? staticNodeText(key) : nameOf(key);
}

function envNameVisitors(report: Parameters<AstRule['create']>[0]): Visitors {
  const sites = new Map<string, { node: EsNode; offset: number }>();
  const helpers = new Set(['productEnv']);
  const calls: { name: string; suffix: string; node: EsNode }[] = [];
  const add = (name: string, node: EsNode) => {
    const offset = typeof node.start === 'number' ? node.start : 0;
    if (!sites.has(name) || sites.get(name)!.offset > offset) sites.set(name, { node, offset });
  };
  const literal = (node: EsNode) => {
    const name = stringOf(node);
    if (name && /^(?:CEZ|HSQ)_[A-Z0-9_]+$/.test(name)) add(name, node);
  };
  const identifier = (node: EsNode) => {
    if (typeof node.name === 'string' && /^(?:CEZ|HSQ)_[A-Z0-9_]+$/.test(node.name)) add(node.name, node);
  };
  return {
    Identifier: identifier,
    JSXIdentifier: identifier,
    PrivateIdentifier: identifier,
    Literal: literal,
    TemplateLiteral: literal,
    ImportSpecifier(node) {
      if (nativeProperty(child(node, 'imported')) !== 'productEnv') return;
      const name = nameOf(child(node, 'local'));
      if (name) helpers.add(name);
    },
    CallExpression(node) {
      const name = nativeProperty(child(node, 'callee'));
      if (!name) return;
      const args = node.arguments as EsNode[];
      const suffix = stringOf(nativeUnwrapped(args[0]));
      if (suffix && /^[A-Z][A-Z0-9_]*$/.test(suffix)) calls.push({ name, suffix, node });
    },
    'Program:exit'() {
      for (const call of calls) {
        if (!helpers.has(call.name)) continue;
        for (const prefix of ['HSQ_', 'CEZ_']) add(`${prefix}${call.suffix}`, call.node);
      }
      documented ??= documentedNames();
      for (const [name, { node }] of sites) {
        if (name.startsWith('CEZ_MOCK_') || documented.has(name)) continue;
        report(node, `${name} is not in .env.example. Document it there in the same commit (AGENTS.md § Zero config; hearsay-tools/cezarion#2970).`);
      }
    },
  };
}

export const undocumentedEnvName: AstRule = {
  name: 'undocumented-env-name',
  description: 'Document every CEZ_* or HSQ_* environment name a shipped source or runner script uses in .env.example.',
  applies: scannedEnvFile,
  create: envNameVisitors,
};
