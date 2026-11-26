import { posix } from 'node:path';
import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { IMPORT_NODE_TYPES, importSpecifier } from './layer-import.ts';

/**
 * A bundled feature folder, `packages/cezar/src/features/<id>/`, registers everything it adds
 * through the plugin API, so nothing outside the folder may import a file inside it (spec
 * 2026-11-26-launch-slot-and-bundled-jobs § 4, hearsay-tools/squawk#4314). Then the product boots
 * and works with the folder absent.
 *
 * Scope: every non-test source file, and a feature file that imports another feature's folder.
 * Tests, testkits, specs, `.d.ts` files and `__fixtures__/` stay out: a test may exercise a feature
 * directly. The rule reads the specifier of each `import` and `export … from` declaration
 * (type-only ones included), a literal `import()`, a literal `import('…')` type, an
 * `import x = require('…')`, and a literal `require('…')` call. A relative specifier resolves
 * against the file; a package specifier (`@hearsay-tools/squawk/…` or the workspace name) counts
 * with or without `src/` or `dist/`. A computed specifier is out of scope. There is no baseline:
 * every finding fails lint.
 */
const SRC = 'packages/cezar/src/';
const FEATURES = `${SRC}features/`;
const PACKAGE = /^(?:@hearsay-tools\/squawk|@wjarka\/cezarion)\/(?:(?:src|dist)\/)?(features\/.*)$/;

/** The feature folder that holds `path`, such as `packages/cezar/src/features/jobs/`, or `undefined`. */
export function featureFolder(path: string): string | undefined {
  if (!path.startsWith(FEATURES)) return undefined;
  const [id, ...rest] = path.slice(FEATURES.length).split('/');
  return id && rest.length > 0 ? `${FEATURES}${id}/` : undefined;
}

const TEST_FILE = /\.(?:test|testkit|spec|d)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

export const applies = (file: string): boolean =>
  SOURCE_FILE.test(file) && !TEST_FILE.test(file) && !/(?:^|\/)__fixtures__\//.test(file);

/** The repository path that `specifier`, written in `file`, names inside a feature folder that does not hold `file`. */
export function featureTarget(file: string, specifier: string | undefined): string | undefined {
  if (!specifier) return undefined;
  const packaged = PACKAGE.exec(specifier)?.[1];
  let target: string;
  if (packaged !== undefined) target = `${SRC}${packaged}`;
  else if (specifier.startsWith('.')) target = posix.join(posix.dirname(file), specifier);
  else return undefined;
  const folder = featureFolder(target.endsWith('/') ? target : `${target}/`);
  if (folder === undefined || file.startsWith(folder)) return undefined;
  return target.replace(/\.js$/, '.ts');
}

const message = (target: string, folder: string) =>
  `Nothing outside a bundled feature folder imports it: ${target} is inside ${folder}. Register what the feature adds through the plugin API in its index.ts instead (hearsay-tools/squawk#4314).`;

function requireSpecifier(node: EsNode): string | undefined {
  return nameOf(child(node, 'callee')) === 'require' ? stringOf(children(node, 'arguments')[0]) : undefined;
}

export function bundledFeatureImportVisitors(report: (node: EsNode, message: string) => void, file: string): Visitors {
  const check = (node: EsNode, specifier: string | undefined) => {
    const target = featureTarget(file, specifier);
    if (target !== undefined) report(node, message(target, featureFolder(target.endsWith('/') ? target : `${target}/`)!));
  };
  return {
    ...Object.fromEntries(IMPORT_NODE_TYPES.map(type => [type, (node: EsNode) => check(node, importSpecifier(node))])),
    CallExpression: node => check(node, requireSpecifier(node)),
  };
}

export const bundledFeatureImport: AstRule = {
  name: 'bundled-feature-import',
  description: 'Nothing outside packages/cezar/src/features/<id>/ imports a file inside it (hearsay-tools/squawk#4314).',
  applies,
  create: (report, { file }) => bundledFeatureImportVisitors(report, file),
};
