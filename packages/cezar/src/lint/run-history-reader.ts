import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { offset, propertyName, unwrap } from './ast-syntax.ts';
import { blankOnce, repoRoot } from './source-rule.ts';

export type HistoryAccess = 'historyPaths' | 'eventsPath-declaration' | 'eventsPath-append' | 'eventsPath' | 'dynamic-path';
export interface HistoryReader { file: string; kind: HistoryAccess; reason: string }
export interface HistorySite { kind: HistoryAccess; offset: number }
export const historyReadersFile = 'packages/cezar/src/lint/run-history-readers.json';

export function readHistoryReaders(path = join(repoRoot, historyReadersFile)): HistoryReader[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: HistoryReader[] }).entries;
}

/** A bare extension fragment can build a transcript; a fixed filename has its own stem. */
function pathFragment(node: Node): boolean {
  const fragment = /(?:^|[^A-Za-z0-9_-])[.]ndjson/;
  if (node.type === 'StringLiteral') return fragment.test(node.value);
  return node.type === 'TemplateElement' && fragment.test(node.value.cooked ?? node.value.raw);
}

/** Literal syntax supplies ownership sites regardless of the surrounding call or expression. */
function pathNodes(node: Node, offsets: Set<number>, parent?: Node): void {
  if (pathFragment(node)) offsets.add((node.type === 'TemplateElement' ? parent?.start : node.start) ?? 0);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') pathNodes(child as Node, offsets, node);
    }
  }
}

/** Parse failures propagate to lint; a malformed source must never hide an ownership finding. */
function dynamicPaths(source: string): HistorySite[] {
  // The old guard searched raw source too; oxlint still refuses malformed files outside this prefilter.
  if (!source.includes('ndjson')) return [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true });
  const offsets = new Set<number>();
  pathNodes(ast, offsets);
  return [...offsets].map((offset) => ({ kind: 'dynamic-path', offset }));
}

/** Raw path access, before exceptions: also used to refuse stale exception entries. */
export function historyAccesses(source: string): HistorySite[] {
  const code = blankOnce(source);
  const sites = dynamicPaths(source);
  const aliases = [...code.matchAll(/\bhistoryPaths\s+as\s+([\w$]+)/g)].map((match) => match[1]!);
  for (const match of code.matchAll(/\b([\w$]+)\s*\(/g)) {
    if (match[1] !== 'historyPaths' && match[1] !== 'eventsPath' && !aliases.includes(match[1]!)) continue;
    let kind: HistoryAccess = match[1] === 'eventsPath' ? 'eventsPath' : 'historyPaths';
    if (kind === 'eventsPath') {
      const before = code.slice(code.lastIndexOf('\n', match.index) + 1, match.index);
      if (/private\s+$/.test(before)) kind = 'eventsPath-declaration';
      else if (/appendFileSync\s*\(\s*this\.$/.test(before)) kind = 'eventsPath-append';
    }
    sites.push({ kind, offset: match.index });
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

let listed: HistoryReader[] | undefined;

export function scanHistoryReaders(file: string, source: string, readers = (listed ??= readHistoryReaders())): HistorySite[] {
  return historyAccesses(source).filter((site) => !readers.some((entry) => entry.file === file && entry.kind === site.kind));
}

export const runHistoryReader: AstRule = {
  name: 'run-history-reader',
  description: 'Keep raw transcript paths in their listed owners (hearsay-tools/cezarion#2420).',
  applies: (file) => file.startsWith('packages/cezar/src/') && file.endsWith('.ts') && !/\.(?:test|testkit)\.ts$/.test(file),
  create(report, { file }) {
    const aliases = new Set(['historyPaths']);
    const sites: Array<{ node: EsNode; kind: HistoryAccess }> = [];
    const path = (node: EsNode, value: string | undefined) => {
      if (value !== undefined && /(?:^|[^A-Za-z0-9_-])[.]ndjson/.test(value)) sites.push({ node, kind: 'dynamic-path' });
    };
    const named = (node: EsNode, name: string | undefined, declaration = false) => {
      if (name !== 'eventsPath' && !aliases.has(name ?? '')) return;
      let kind: HistoryAccess = name === 'eventsPath' ? 'eventsPath' : 'historyPaths';
      if (kind === 'eventsPath') {
        if (declaration && node.accessibility === 'private') kind = 'eventsPath-declaration';
        else if (!declaration) {
          const callee = unwrap(child(node, 'callee'));
          const parent = node.parent;
          if (callee?.type === 'MemberExpression' && child(callee, 'object')?.type === 'ThisExpression'
            && parent?.type === 'CallExpression' && nameOf(child(parent, 'callee')) === 'appendFileSync'
            && children(parent, 'arguments')[0] === node) kind = 'eventsPath-append';
        }
      }
      sites.push({ node, kind });
    };
    return {
      Program(node) {
        for (const statement of children(node, 'body')) for (const specifier of children(statement, 'specifiers')) {
          if (specifier.type === 'ImportSpecifier' && nameOf(child(specifier, 'imported')) === 'historyPaths') aliases.add(nameOf(child(specifier, 'local'))!);
        }
      },
      CallExpression(node) {
        const callee = unwrap(child(node, 'callee'));
        if (callee?.type === 'MemberExpression' && callee.computed) return;
        named(node, propertyName(callee));
      },
      MethodDefinition(node) { named(node, propertyName(child(node, 'key')), true); },
      FunctionDeclaration(node) { named(node, nameOf(child(node, 'id')), true); },
      Literal(node) { path(node, stringOf(node)); },
      TemplateLiteral(node) {
        if (children(node, 'quasis').some(quasi => {
          const value = quasi.value as { cooked?: string; raw: string };
          return /(?:^|[^A-Za-z0-9_-])[.]ndjson/.test(value.cooked ?? value.raw);
        })) sites.push({ node, kind: 'dynamic-path' });
      },
      'Program:exit'() {
        const readers = listed ??= readHistoryReaders();
        sites.sort((a, b) => offset(a.node) - offset(b.node));
        for (const { node, kind } of sites) if (!readers.some(entry => entry.file === file && entry.kind === kind)) {
          report(node, `${kind}: use compression-aware history-file.ts APIs; raw transcript paths belong to the reasoned run-history-readers.json owners (hearsay-tools/cezarion#2420).`);
        }
      },
    };
  },
};
