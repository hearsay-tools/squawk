import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from '@babel/parser';
import { PLUGIN_ENTRY_SUBPATHS } from '../plugin/resolve-hook.ts';

const PLUGIN_DIR = join(import.meta.dirname, '..', 'plugin');

type Node = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };

/** The module a dynamic import's argument names, when it is one string or one plain template. */
function literalSpecifier(argument: Node | undefined): string | undefined {
  if (argument?.type === 'StringLiteral') return argument.value as string;
  if (argument?.type !== 'TemplateLiteral' || (argument.expressions as unknown[]).length > 0) return undefined;
  return ((argument.quasis as Array<{ value: { cooked: string } }>)[0]!).value.cooked;
}

/** The module a value declaration loads: `import`, `export … from` or `import x = require('…')`. */
function declaredModule(node: Node): string | undefined {
  if (node.type === 'ImportDeclaration' && node.importKind !== 'type') return (node.source as Node).value as string;
  const reExport = node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration';
  if (reExport && node.source && node.exportKind !== 'type') return (node.source as Node).value as string;
  const reference = node.type === 'TSImportEqualsDeclaration' && node.importKind !== 'type' ? node.moduleReference as Node : undefined;
  return reference?.type === 'TSExternalModuleReference' ? (reference.expression as Node).value as string : undefined;
}

/** The argument of an expression that loads a module, `import(…)` or `require(…)`; null when it has none. */
function loadArgument(node: Node): Node | null | undefined {
  if (node.type === 'ImportExpression') return node.source as Node;
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as Node;
  const loads = callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
  return loads ? (node.arguments as Node[])[0] ?? null : undefined;
}

/** The syntax nodes directly under `node`, comments left out. */
function children(node: Node): Node[] {
  return Object.entries(node)
    .filter(([key]) => !key.endsWith('Comments'))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((child): child is Node => Boolean(child) && typeof child === 'object' && typeof (child as Node).type === 'string');
}

/** Whether `node` calls Vite's `import.meta.glob`, which plain Node does not have. */
function isViteGlob(node: Node): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Node;
  const property = callee.property as Node | undefined;
  return callee.type === 'MemberExpression' && (callee.object as Node).type === 'MetaProperty'
    && property?.type === 'Identifier' && property.name === 'glob';
}

/**
 * The glob a relative template literal names when each substitution sits between two slashes and
 * the file name is literal: `../runners/${id}/facts.ts` names every `facts.ts` at any depth below
 * `../runners/`. A substitution may hold slashes, and esbuild bundles every file such a template
 * matches at any depth, so the glob does too. Any other template is undefined.
 */
function folderGlob(argument: Node | undefined): string | undefined {
  if (argument?.type !== 'TemplateLiteral' || (argument.expressions as unknown[]).length === 0) return undefined;
  const parts = (argument.quasis as Array<{ value: { cooked: string } }>).map(quasi => quasi.value.cooked);
  const wholeSegments = parts.slice(0, -1).every(part => part.endsWith('/')) && parts.slice(1).every(part => part.startsWith('/'));
  const pattern = parts.join('**');
  return /^\.\.?\//.test(pattern) && wholeSegments ? pattern : undefined;
}

/** The files a glob written in `file` matches, as sorted relative specifiers: `./` or `../` first. */
export function globMatches(pattern: string, file: string): string[] {
  return globSync(pattern, { cwd: dirname(file) }).map(match => (/^\.\.?\//.test(match) ? match : `./${match}`)).sort();
}

/**
 * Every module specifier `source` loads at runtime, read from its syntax tree: value `import`,
 * `export … from` and `import x = require(…)` declarations, and `import(…)` and `require(…)`
 * calls. TypeScript erases type-only imports and `import('…').T` type queries, so they are not
 * counted. An `import(`…`)` template whose substitutions fill whole folder segments loads every
 * file it matches beside `file`, as esbuild bundles it. A load whose argument is neither one
 * literal nor such a template throws: a closure pin that skipped it would fail open. So does
 * Vite's `import.meta.glob`, which plain Node scripts cannot run. `file` picks the JSX grammar
 * for a `.jsx` or `.tsx` source.
 */
export function runtimeImports(source: string, file = 'module.ts'): string[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', ...(/\.[cm]?[jt]sx$/.test(file) ? ['jsx' as const] : [])],
  }) as unknown as Node;
  const found: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'TSImportType') return;
    const declared = declaredModule(node);
    const argument = declared === undefined ? loadArgument(node) : undefined;
    const call = source.slice(node.start ?? 0, node.end ?? 0);
    if (isViteGlob(node)) throw new Error(`${file}: import.meta.glob runs only under Vite; plain Node scripts that load this module fail: ${call}`);
    const glob = node.type === 'ImportExpression' || (node.callee as Node | undefined)?.type === 'Import' ? folderGlob(argument ?? undefined) : undefined;
    if (declared !== undefined) found.push(declared);
    else if (glob !== undefined) found.push(...globMatches(glob, file));
    else if (argument !== undefined) found.push(literalOrThrow(argument ?? undefined, file, call));
    children(node).forEach(visit);
  };
  visit(ast);
  return found;
}

function literalOrThrow(argument: Node | undefined, file: string, call: string): string {
  const specifier = literalSpecifier(argument);
  if (specifier === undefined) throw new Error(`${file}: a runtime import names no literal module, so its closure cannot be walked: ${call}`);
  return specifier;
}

/** The relative modules `source` imports for their values; type-only imports are erased. */
export function relativeImports(source: string, file?: string): string[] {
  return runtimeImports(source, file).filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'));
}

/** Every module `entry` (an absolute `.ts` path) loads at runtime through relative imports and
 *  allowlisted `@hearsay-tools/squawk/plugin*` entries, as absolute paths. */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of runtimeImports(readFileSync(path, 'utf8'), path)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        visit(join(dirname(path), specifier).replace(/\.js$/, '.ts'));
      } else if (Object.hasOwn(PLUGIN_ENTRY_SUBPATHS, specifier)) {
        visit(join(PLUGIN_DIR, `${PLUGIN_ENTRY_SUBPATHS[specifier]}.ts`));
      }
    }
  };
  visit(entry);
  return [...seen].sort();
}
