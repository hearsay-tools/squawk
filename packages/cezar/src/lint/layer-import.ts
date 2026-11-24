import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { visit } from './babel-walk.ts';
import { repoRoot } from './source-rule.ts';
import { child, stringOf, type AstRule, type EsNode, type Report, type Visitors } from './ast-rule.ts';

/**
 * The core does not depend on a feature (ADR 0065, hearsay-tools/squawk#3706). `layers.json`
 * puts every non-test source file of `packages/cezar/src` in one layer: `core`, `runner`,
 * `shell`, `tooling` or `feature:<name>`.
 *
 * Static scope: non-test `.ts` files under `packages/cezar/src/` that the map puts in `core`.
 * The rule reads each relative specifier of an `import` or `export … from` declaration (type-only
 * ones included), a literal `import()`, a literal `import('…')` type and an
 * `import x = require('…')`. It maps `.js` to `.ts` and reports
 * - an import of a `feature:<name>` file;
 * - an import of a `runner` file. The core builds runners only through the registry
 *   (`core/runner-registry.ts`), which the entries fill from `runners/built-in.ts`.
 * It does not read package specifiers, a computed specifier or a re-export chain: a core file
 * that imports a core file that imports a feature is not reported at the first file. Imports from
 * `shell`, `tooling`, `runner` and `feature` files are out of its scope.
 *
 * `layer-import.baseline.json` lists the imports the rule lets pass, each by importing file,
 * imported file, count and reason. It only shrinks: `npm run lint` fails a stale entry, and CI's
 * baseline-growth gate refuses a new one. `layerMapProblems` fails a source file with no layer,
 * a map path that matches no file, and a path listed twice.
 */
export const layerMapFile = 'packages/cezar/src/lint/layers.json';
export const layerImportBaselineFile = 'packages/cezar/src/lint/layer-import.baseline.json';
const SRC = 'packages/cezar/src/';
const LAYER_NAME = /^(?:core|runner|shell|tooling|feature:[a-z][a-z0-9-]*)$/;

/** One path of the map. */
export interface LayerPath { layer: string; path: string }

export function readLayerMap(path = join(repoRoot, layerMapFile)): LayerPath[] {
  const { layers } = JSON.parse(readFileSync(path, 'utf8')) as { layers: Record<string, string[]> };
  return Object.entries(layers).flatMap(([layer, paths]) => paths.map(entry => ({ layer, path: entry })));
}

/** Whether a map path covers `file`, a path relative to `packages/cezar/src/`. */
export function covers(path: string, file: string): boolean {
  if (path.endsWith('/')) return file.startsWith(path);
  if (path.endsWith('*')) return file.startsWith(path.slice(0, -1)) && !file.slice(path.length - 1).includes('/');
  return file === path;
}

/** The map paths that cover `file`, the longest first. */
const matches = (file: string, map: readonly LayerPath[]) => map.filter(entry => covers(entry.path, file)).sort((a, b) => b.path.length - a.path.length);

/** The layer of `file`, a path relative to `packages/cezar/src/`; `undefined` when no path covers it. */
export function layerOf(file: string, map: readonly LayerPath[]): string | undefined {
  return matches(file, map)[0]?.layer;
}

/** A source file the map must place: a `.ts` file that is no test, testkit, declaration or fixture. */
export const isLayeredSource = (file: string): boolean =>
  file.endsWith('.ts') && !/\.(?:test|testkit|d)\.ts$/.test(file) && !/(?:^|\/)__fixtures__\//.test(file);

/** One relative import in a file, resolved to a path relative to `packages/cezar/src/`. */
export interface LayerImport { target: string; offset: number }

function specifierText(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TSLiteralType' && node.literal.type === 'StringLiteral') return node.literal.value;
  return undefined;
}

/** The literal specifier a node names, when the node is one of the import forms the rule reads. */
function specifierOf(node: Node): string | undefined {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
      return specifierText(node.source);
    case 'ImportExpression':
      return specifierText(node.source);
    case 'CallExpression':
      return node.callee.type === 'Import' ? specifierText(node.arguments[0]) : undefined;
    case 'TSImportType': {
      const typed = node as unknown as { source?: Node; argument?: Node };
      return specifierText(typed.source ?? typed.argument);
    }
    case 'TSImportEqualsDeclaration':
      return node.moduleReference.type === 'TSExternalModuleReference' ? specifierText(node.moduleReference.expression) : undefined;
    default:
      return undefined;
  }
}

/** One relative specifier in a source, with the offset of the import that names it. */
export interface RelativeSpecifier { specifier: string; offset: number }

/** All literal import specifiers of the import forms this rule reads, in source order. */
export function literalSpecifiers(source: string): RelativeSpecifier[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const found: RelativeSpecifier[] = [];
  visit(ast.program, (node) => {
    const specifier = specifierOf(node);
    if (specifier !== undefined) found.push({ specifier, offset: node.start ?? 0 });
  });
  return found.sort((a, b) => a.offset - b.offset);
}

/** The relative specifiers of the import forms this rule reads, in source order. */
export function relativeSpecifiers(source: string): RelativeSpecifier[] {
  // An import the rule reads needs a quoted relative specifier; a file with none is not parsed.
  if (!/['"]\.\.?\//.test(source)) return [];
  return literalSpecifiers(source).filter(({ specifier }) => specifier.startsWith('.'));
}

/** The relative imports of `file` (a path relative to `packages/cezar/src/`) that stay inside it. */
export function layerImports(file: string, source: string): LayerImport[] {
  return relativeSpecifiers(source).flatMap(({ specifier, offset }) => {
    const target = posix.join(posix.dirname(file), specifier).replace(/\.js$/, '.ts');
    return target.startsWith('../') ? [] : [{ target, offset }];
  });
}

/** Why `from` may not import `target`, or `undefined` when it may. */
export function crossing(file: string, target: string, map: readonly LayerPath[]): string | undefined {
  if (layerOf(file, map) !== 'core') return undefined;
  const to = layerOf(target, map);
  if (to?.startsWith('feature:')) return `a core file imports ${to} (${target})`;
  if (to === 'runner') return `a core file imports the runner file ${target}; the core builds runners only through core/runner-registry.ts`;
  return undefined;
}

/** One core import of a feature or a runner file. */
export interface LayerCrossing { target: string; offset: number; reason: string }

/** The crossings in `file`, a path relative to `packages/cezar/src/`. */
export function layerCrossings(file: string, source: string, map: readonly LayerPath[]): LayerCrossing[] {
  if (layerOf(file, map) !== 'core') return [];
  return layerImports(file, source).flatMap(({ target, offset }) => {
    const reason = crossing(file, target, map);
    return reason === undefined ? [] : [{ target, offset, reason }];
  });
}

/** Imports the rule lets pass `count` times from `file` to `target`, both repository paths. */
export interface LayerImportException { file: string; target: string; count: number; reason: string }

export function readLayerImportExceptions(path = join(repoRoot, layerImportBaselineFile)): LayerImportException[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: LayerImportException[] }).entries;
}

let loadedMap: LayerPath[] | undefined;
let listed: LayerImportException[] | undefined;

/** The crossings beyond what the baseline allows: of each target, the ones after its allowed count. */
export function scanLayerImports(file: string, source: string, map = (loadedMap ??= readLayerMap()), exceptions = (listed ??= readLayerImportExceptions())): LayerCrossing[] {
  if (!file.startsWith(SRC)) return [];
  const local = file.slice(SRC.length);
  const seen = new Map<string, number>();
  return layerCrossings(local, source, map).filter(({ target }) => {
    const count = (seen.get(target) ?? 0) + 1;
    seen.set(target, count);
    return count > (exceptions.find(entry => entry.file === file && entry.target === `${SRC}${target}`)?.count ?? 0);
  });
}

const applies = (file: string) => file.startsWith(SRC) && isLayeredSource(file);

/** Every source file the map must place, relative to `packages/cezar/src/`. */
export function layeredSources(root = repoRoot): string[] {
  const base = join(root, SRC);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (isLayeredSource(path)) files.push(path);
    }
  };
  walk('');
  return files.sort();
}

/**
 * The map's problems under `root`: a source file no path covers, a path that covers no file, a
 * path listed twice, two paths of one length that place a file in two layers, and a layer name
 * outside the five kinds.
 */
export function layerMapProblems(root = repoRoot): string[] {
  const map = readLayerMap(join(root, layerMapFile));
  const files = layeredSources(root);
  const problems: string[] = [];
  const at = `${layerMapFile}:1 cez/layer-import:`;
  const listedPaths = new Set<string>();
  for (const { layer, path } of map) {
    if (!LAYER_NAME.test(layer)) problems.push(`${at} ${layer} is no layer name; use core, runner, shell, tooling or feature:<name>`);
    if (listedPaths.has(path)) problems.push(`${at} ${path} is listed twice; keep it in one layer`);
    listedPaths.add(path);
    if (!files.some(file => covers(path, file))) problems.push(`${at} ${path} matches no source file; remove it`);
  }
  for (const file of files) {
    const [first, second] = matches(file, map);
    if (first === undefined) {
      problems.push(`${SRC}${file}:1 cez/layer-import: ${file} has no layer. Add it to ${layerMapFile} (ADR 0065)`);
    } else if (second !== undefined && second.path.length === first.path.length && second.layer !== first.layer) {
      problems.push(`${at} ${first.path} and ${second.path} both place ${file}; make one path longer`);
    }
  }
  return problems;
}

/** Baseline entries that allow more than the file still has, repeat another entry, or give no reason. */
export function staleLayerImports(root = repoRoot): string[] {
  const map = readLayerMap(join(root, layerMapFile));
  const seen = new Set<string>();
  return readLayerImportExceptions(join(root, layerImportBaselineFile)).flatMap((entry) => {
    const path = join(root, entry.file);
    const local = entry.file.slice(SRC.length);
    const actual = entry.file.startsWith(SRC) && existsSync(path)
      ? layerCrossings(local, readFileSync(path, 'utf8'), map).filter(({ target }) => `${SRC}${target}` === entry.target).length
      : 0;
    const key = `${entry.file}\n${entry.target}`;
    const valid = applies(entry.file) && Number.isInteger(entry.count) && entry.count > 0 && entry.reason.trim() !== '' && !seen.has(key);
    seen.add(key);
    return valid && actual === entry.count ? [] : [
      `${layerImportBaselineFile} cez/layer-import: stale or invalid entry ${entry.file} → ${entry.target} (lists ${entry.count}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

/** The import node types whose literal specifier `importSpecifier` reads. */
export const IMPORT_NODE_TYPES = ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression', 'TSImportType', 'TSImportEqualsDeclaration'] as const;

/** Read only literal import nodes; computed specifiers and re-export chains stay out of scope. */
export function importSpecifier(node: EsNode): string | undefined {
  if (node.type === 'TSImportEqualsDeclaration') {
    const reference = child(node, 'moduleReference');
    return reference?.type === 'TSExternalModuleReference' ? stringOf(child(reference, 'expression')) : undefined;
  }
  const source = child(node, 'source');
  return source?.type === 'Literal' ? stringOf(source) : undefined;
}

/** The same layer map and count allowances, fed by oxlint's import visitors. */
export function layerImportVisitors(report: Report, file: string, map = (loadedMap ??= readLayerMap()), exceptions = (listed ??= readLayerImportExceptions())): Visitors {
  const local = file.slice(SRC.length);
  if (layerOf(local, map) !== 'core') return {};
  const seen = new Map<string, number>();
  const inspect = (node: EsNode) => {
    const specifier = importSpecifier(node);
    if (!specifier?.startsWith('.')) return;
    const target = posix.join(posix.dirname(local), specifier).replace(/\.js$/, '.ts');
    if (target.startsWith('../')) return;
    const reason = crossing(local, target, map);
    if (reason === undefined) return;
    const count = (seen.get(target) ?? 0) + 1;
    seen.set(target, count);
    if (count <= (exceptions.find(entry => entry.file === file && entry.target === `${SRC}${target}`)?.count ?? 0)) return;
    report(node, `${reason}. The core does not depend on a feature or a runner (ADR 0065, hearsay-tools/squawk#3706). Move the shared code into core, or invert the dependency; see ${layerMapFile}.`);
  };
  return Object.fromEntries(IMPORT_NODE_TYPES.map(type => [type, inspect]));
}

export const layerImport: AstRule = {
  name: 'layer-import',
  description: 'A core file imports no feature file and no runner file (ADR 0065, hearsay-tools/squawk#3706).',
  applies,
  create: (report, context) => layerImportVisitors(report, context.file),
};
