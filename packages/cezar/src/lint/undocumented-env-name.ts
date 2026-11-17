import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './source-rule.ts';
import { child, nameOf, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { scanSource, staticNodeText } from './ast-tree.ts';

/**
 * `.env.example` is the env contract (AGENTS.md § Zero config): every `CEZ_*` or `HSQ_*` name a shipped source
 * or runner script reads or writes is documented there. This proves documentation coverage, not
 * correct default behavior.
 */
const SCANNED = ['packages/cezar/src/', 'packages/contract/src/', 'packages/api-client/src/', 'packages/web/src/', 'packages/cezar/scripts/'];
export const envExamplePath = join(repoRoot, '.env.example');

/** A literal `productEnv` suffix: only it proves both accepted full names. Anything else is `undefined`. */
export function productEnvSuffix(argument: EsNode | undefined): string | undefined {
  const suffix = stringOf(nativeUnwrapped(argument));
  return suffix !== undefined && /^[A-Z][A-Z0-9_]*$/.test(suffix) ? suffix : undefined;
}

/**
 * Each `CEZ_*` or `HSQ_*` name in `source`, sorted. A conservative source scan, not data-flow
 * analysis: identifiers, complete literal values and literal `productEnv` suffixes. Examples inside
 * longer strings and comments are not environment names. It runs the rule's own visitors.
 */
export function envNames(source: string, file = 'file.ts'): string[] {
  const scan = envNameSites();
  let names: string[] = [];
  scanSource(file, source, () => ({ ...scan.visitors, 'Program:exit'() { names = [...scan.sites().keys()].sort(); } }));
  return names;
}

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

/** The visitors that find environment names in one file, and each name's first site. */
function envNameSites(): { visitors: Visitors; sites(): Map<string, { node: EsNode; offset: number }> } {
  const sites = new Map<string, { node: EsNode; offset: number }>();
  const helpers = new Set(['productEnv']);
  const calls: { name: string; suffix: string; node: EsNode }[] = [];
  const add = (name: string, node: EsNode) => {
    const offset = typeof node.start === 'number' ? node.start : 0;
    if (!sites.has(name) || sites.get(name)!.offset > offset) sites.set(name, { node, offset });
  };
  const literal = (node: EsNode) => {
    const name = stringOf(node);
    if (name && /^(?:CEZ|HSQ)_[A-Z0-9_]*[A-Z0-9]$/.test(name)) add(name, node);
  };
  const identifier = (node: EsNode) => {
    if (typeof node.name === 'string' && /^(?:CEZ|HSQ)_[A-Z0-9_]+$/.test(node.name)) add(node.name, node);
  };
  const visitors: Visitors = {
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
      const suffix = productEnvSuffix((node.arguments as EsNode[])[0]);
      if (suffix) calls.push({ name, suffix, node });
    },
  };
  return {
    visitors,
    sites() {
      for (const call of calls) {
        if (!helpers.has(call.name)) continue;
        for (const prefix of ['HSQ_', 'CEZ_']) add(`${prefix}${call.suffix}`, call.node);
      }
      return sites;
    },
  };
}

function envNameVisitors(report: Parameters<AstRule['create']>[0]): Visitors {
  const scan = envNameSites();
  return {
    ...scan.visitors,
    'Program:exit'() {
      documented ??= documentedNames();
      for (const [name, { node }] of scan.sites()) {
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
