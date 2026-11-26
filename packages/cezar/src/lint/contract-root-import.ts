import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { repoRoot } from './source-rule.ts';
import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Visitors } from './ast-rule.ts';
import { scanSource } from './ast-tree.ts';

/**
 * Contract values load through module subpaths, never through a package root
 * (hearsay-tools/cezarion#1237).
 *
 * Both roots, `@open-mercato/cezar-contract` and `@open-mercato/cezar-api-client`, re-export every
 * contract module, delegation's schemas among them. A value imported through a root puts all of
 * them in the importer's runtime closure, so an edit to any shared schema reruns tests that never
 * use it. A type import costs nothing at runtime, so the roots stay open to `import type`, to
 * `export type … from` and to an `import('<root>').T` type query inside a type alias. Everything
 * else is refused.
 */
const ROOTS = ['@open-mercato/cezar-contract', '@open-mercato/cezar-api-client'];
export const SCANNED = ['packages/cezar/src', 'packages/cezar/test', 'packages/web/src', 'packages/web/e2e', 'packages/api-client/src', 'packages/contract/src'];
export const exemptionsPath = join(repoRoot, 'packages/cezar/src/lint/contract-root-import.baseline.json');

/** Files allowed to import a root at runtime, each with its reason. The list only shrinks. */
export function readExemptions(path = exemptionsPath): Record<string, string> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, string> }).files;
}

type Kind = 'value-import' | 'side-effect' | 'namespace' | 'default' | 're-export' | 'dynamic';
export interface RootImport { file: string; line: number; root: string; kind: Kind; names: string[] }

const rootOf = (specifier: string): string | undefined =>
  ROOTS.find((root) => specifier === root || specifier === `${root}/index`);

/** Every runtime import of a package root in `source`, read from oxlint's syntax tree. */
export function scanRootImports(file: string, source: string): RootImport[] {
  const sites: RootImport[] = [];
  scanSource(file, source, () => rootImportVisitors(file, (node, site) => {
    const loc = node.loc as { start?: { line?: number } } | undefined;
    sites.push({ ...site, line: loc?.start?.line ?? 1 });
  }));
  return sites;
}

export const contractModules = (root = repoRoot): string[] => readdirSync(join(root, 'packages/contract/src'))
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.endsWith('.test.ts'))
  .map((name) => name.slice(0, -'.ts'.length))
  .sort();

type Owners = Map<string, { contract?: string; apiClient?: string }>;

/** The subpath that defines each exported value, for the diagnostic. */
function subpathOwners(): Owners {
  const owners: Owners = new Map();
  const record = (path: string, key: 'contract' | 'apiClient', subpath: string) => {
    const ast = parse(readFileSync(join(repoRoot, path), 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    for (const statement of ast.program.body) {
      if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) continue;
      const declaration = statement.declaration;
      const ids = declaration.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap(item => item.id.type === 'Identifier' ? [item.id.name] : [])
        : 'id' in declaration && declaration.id?.type === 'Identifier' ? [declaration.id.name] : [];
      for (const name of ids) owners.set(name, { ...owners.get(name), [key]: subpath });
    }
  };
  for (const name of contractModules()) record(`packages/contract/src/${name}.ts`, 'contract', name);
  for (const path of ['client', 'protocol/ui-events', 'utils/project-scope']) {
    record(`packages/api-client/src/${path}.ts`, 'apiClient', path);
  }
  return owners;
}

let owners: Owners | undefined;

/** What the site imports and the subpath each name comes from. */
export function hint(site: RootImport, known: Owners = (owners ??= subpathOwners())): string {
  const advice = site.names.map((name) => {
    if (name.startsWith('type ')) return `${name.slice(5)} → \`import type\` from the root`;
    const owner = known.get(name);
    if (owner?.apiClient) return `${name} → @open-mercato/cezar-api-client/${owner.apiClient}`;
    if (owner?.contract) {
      return site.root === '@open-mercato/cezar-api-client'
        ? `${name} → @open-mercato/cezar-api-client/contract/${owner.contract}`
        : `${name} → @open-mercato/cezar-contract/${owner.contract}`;
    }
    return `${name} → (no defining module found)`;
  });
  return `${site.kind} of ${site.root}${advice.length ? `: ${advice.join(', ')}` : ''}`;
}

export const scanned = (file: string): boolean =>
  SCANNED.some((dir) => file.startsWith(`${dir}/`)) && /\.tsx?$/.test(file) && !/\/(?:node_modules|dist|__fixtures__)\//.test(file);

let exemptions: Record<string, string> | undefined;

/** The kind, root and names of one root import node. */
function rootImportNode(file: string, node: EsNode): RootImport | undefined {
  const specifier = child(node, 'source');
  const root = rootOf(stringOf(specifier) ?? '');
  if (!root) return undefined;
  if (node.importKind === 'type' || node.exportKind === 'type') return undefined;
  const specifiers = children(node, 'specifiers');
  const names = specifiers.filter(item => item.type === 'ImportSpecifier' || item.type === 'ExportSpecifier').map(item => {
    const imported = child(item, item.type === 'ImportSpecifier' ? 'imported' : 'local');
    return `${item.importKind === 'type' || item.exportKind === 'type' ? 'type ' : ''}${nameOf(imported) ?? stringOf(imported) ?? ''}`;
  });
  let kind: Kind;
  if (node.type === 'ImportExpression' || node.type === 'TSImportType') kind = 'dynamic';
  else if (node.type.startsWith('Export')) kind = 're-export';
  else if (specifiers.length === 0) kind = 'side-effect';
  else if (specifiers[0]?.type === 'ImportNamespaceSpecifier') kind = 'namespace';
  else kind = specifiers[0]?.type === 'ImportSpecifier' ? 'value-import' : 'default';
  return { file, line: 1, root, kind, names };
}

/** Visitors that call `found` for each runtime import of a root. A type query inside a type alias is a type. */
function rootImportVisitors(file: string, found: (node: EsNode, site: RootImport) => void): Visitors {
  const inspect = (node: EsNode) => {
    if (node.type === 'TSImportType') {
      for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === 'TSTypeAliasDeclaration') return;
    }
    const site = rootImportNode(file, node);
    if (site) found(node, site);
  };
  return Object.fromEntries(['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression', 'TSImportType'].map(type => [type, inspect]));
}

export const contractRootImport: AstRule = {
  name: 'contract-root-import',
  description: 'Import contract values through module subpaths, never through a package root (hearsay-tools/cezarion#1237).',
  applies: (file) => scanned(file) && !(file in (exemptions ??= readExemptions())),
  create(report, context) {
    return rootImportVisitors(context.file, (node, site) =>
      report(node, `${hint(site)}. Import values from the subpaths named, or types as \`import type\` from the root (hearsay-tools/cezarion#1237).`));
  },
};
