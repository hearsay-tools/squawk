import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { child, children, nameOf, stringOf, type AstRule, type EsNode, type Report, type Visitors } from './ast-rule.ts';
import { literal, offset, propertyName, unwrap } from './ast-syntax.ts';
import { scanSource } from './ast-tree.ts';
import { repoRoot } from './source-rule.ts';
import { bundledRunnerIds } from '../plugin/bundled-runners.ts';

/**
 * Each bundled runner folder must stay self-contained so its built folder (`dist/runners/<id>/`)
 * can be copied into `<config>/plugins/` unchanged and run with no `npm install`
 * (spec 2026-11-25-self-contained-runner-folders, decision 6, hearsay-tools/squawk#4255).
 *
 * Static scope: every non-test JS/TS file under `packages/cezar/src/runners/<id>/` (`.ts`, `.tsx`,
 * `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), excluding `fixture/`, `__fixtures__/`,
 * `*.test.*`, `*.testkit.*`, and `*.d.*`. The rule reports:
 * - `new URL(spec, import.meta.url)` (and `new globalThis.URL(...)`) whose relative or
 *   root-relative literal, template with static leading prefix, or `+`-concatenated static prefix
 *   resolves outside the file's own runner folder;
 * - a `join` or `resolve` call (direct, aliased from `node:path*`/`path*`, or member on
 *   `path`/`posix`/`win32`/`path.posix`/`path.win32` or an imported path namespace) whose literal
 *   `'..'` segments climb out of the file's own runner folder;
 * - a relative static or dynamic import/export/require specifier (`import`, `export … from`,
 *   `import()`, `import('…')` type, `import x = require('…')`, `require('…')`) that leaves the
 *   file's own runner folder;
 * - an import/export/require of any non-relative specifier other than `node:*` built-ins and
 *   `@hearsay-tools/squawk/plugin` (or `@hearsay-tools/squawk/plugin/*` without `'..'`).
 *
 * Limits: the rule tracks imports of `node:path*`/`path*` aliases within the file, not arbitrary
 * variable values, helper calls, dynamic bases without a static prefix, or destructured path
 * bindings. `new URL(spec, otherBase)` where the base is not `import.meta.url` is out of scope.
 *
 * Each runner has its own shrink-only baseline file under
 * `packages/cezar/src/lint/runner-folder-escape/<id>.baseline.json`. `npm run lint` fails any
 * stale, duplicate, misfiled, or invalid entry, and CI's baseline-growth gate refuses growth.
 */

export const runnerFolderEscapeBaselineDir = 'packages/cezar/src/lint/runner-folder-escape';

const RUNNERS_DIR = 'packages/cezar/src/runners/';
const SHARED_FOLDERS = new Set(['fixture']);
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;
const EXCLUDED_FILE = /\.(?:test|testkit|d)\.[cm]?[jt]sx?$/;
const FIXTURES_SEGMENT = /(?:^|\/)__fixtures__\//;
const PATH_MODULES = new Set(['node:path', 'node:path/posix', 'node:path/win32', 'path', 'path/posix', 'path/win32']);
const DEFAULT_PATH_NAMESPACES = new Set(['path', 'posix', 'win32']);
const PATH_JOIN_METHODS = new Set(['join', 'resolve']);
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const ABSOLUTE_PATH = /^(?:\/|\\|[a-zA-Z]:[/\\])/;
const PLUGIN_SPECIFIER = /^@hearsay-tools\/squawk\/plugin(?:\/|$)/;
const VALID_KINDS = new Set<RunnerFolderEscapeKind>(['url', 'path', 'import', 'package']);

export type RunnerFolderEscapeKind = 'url' | 'path' | 'import' | 'package';

/** One folder escape found in a runner file. */
export interface RunnerFolderEscapeFinding {
  kind: RunnerFolderEscapeKind;
  target: string;
}

/** Escapes allowed `count` times in `file` for a given `kind` and `target`. */
export interface RunnerFolderEscapeException {
  file: string;
  kind: RunnerFolderEscapeKind;
  target: string;
  count: number;
}

/** The repository path of `runnerId`'s baseline file. */
export function runnerFolderEscapeBaselineFile(runnerId: string): string {
  return `${runnerFolderEscapeBaselineDir}/${runnerId}.baseline.json`;
}

/** The runner id for `file` under `packages/cezar/src/runners/<id>/`, excluding `fixture/`. */
export function runnerIdOf(file: string): string | undefined {
  if (!file.startsWith(RUNNERS_DIR)) return undefined;
  const [id, ...rest] = file.slice(RUNNERS_DIR.length).split('/');
  if (!id || rest.length === 0 || SHARED_FOLDERS.has(id)) return undefined;
  return id;
}

/** The runner folder prefix (`packages/cezar/src/runners/<id>/`) for `file`, or `undefined`. */
export function runnerFolderOf(file: string): string | undefined {
  const id = runnerIdOf(file);
  return id === undefined ? undefined : `${RUNNERS_DIR}${id}/`;
}

/** Whether `file` is inside `cez/runner-folder-escape`'s static scope. */
export function applies(file: string): boolean {
  return runnerIdOf(file) !== undefined
    && SOURCE_EXT.test(file)
    && !EXCLUDED_FILE.test(file)
    && !FIXTURES_SEGMENT.test(file);
}

/** Directory depth of `file` inside its runner folder (0 for `<id>/a.ts`, 1 for `<id>/sub/a.ts`). */
function depthInRunnerFolder(file: string, folder: string): number {
  return file.slice(folder.length).split('/').length - 1;
}

/** Whether a non-relative module specifier is allowed inside a self-contained runner folder. */
export function isAllowedPackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) {
    const rest = specifier.slice(5);
    return rest.length > 0 && !rest.startsWith('/') && !rest.split('/').includes('..');
  }
  return PLUGIN_SPECIFIER.test(specifier) && !specifier.split('/').includes('..');
}

/**
 * Resolve a relative segment sequence from `file` inside `folder`. Returns the target label when
 * the segments climb out of `folder` at any step, or `undefined` when they stay inside `folder`.
 */
function escapedRelativeTarget(file: string, folder: string, segments: readonly string[]): string | undefined {
  let depth = depthInRunnerFolder(file, folder);
  let escaped = false;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) escaped = true;
    } else {
      depth += 1;
    }
  }
  if (!escaped) return undefined;
  const dir = posix.dirname(file);
  const resolved = posix.join(dir, ...segments);
  const folderRoot = folder.slice(0, -1);
  if (resolved === folderRoot || resolved.startsWith(folder)) return segments.join('/');
  return resolved;
}

/** Flatten a `+` binary expression left-to-right into operands. */
function flattenPlus(node: EsNode, out: EsNode[]): void {
  const expr = unwrap(node);
  if (!expr) return;
  if (expr.type === 'BinaryExpression' && expr.operator === '+') {
    const left = child(expr, 'left');
    const right = child(expr, 'right');
    if (left) flattenPlus(left, out);
    if (right) flattenPlus(right, out);
    return;
  }
  out.push(expr);
}

/**
 * Extract a static string, or a template / `+`-concat pattern with a non-empty static leading
 * prefix (substituting `*` for dynamic interpolations).
 */
function staticOrPrefixedText(node: EsNode | undefined): string | undefined {
  const exact = literal(node);
  if (exact !== undefined) return exact;
  const expr = unwrap(node);
  if (!expr) return undefined;
  if (expr.type === 'TemplateLiteral') {
    const quasis = children(expr, 'quasis');
    const parts = quasis.map(q => (q.value as { cooked?: unknown } | undefined)?.cooked);
    if (parts.some(part => typeof part !== 'string') || (parts[0] as string) === '') return undefined;
    return (parts as string[]).join('*');
  }
  if (expr.type === 'BinaryExpression' && expr.operator === '+') {
    const operands: EsNode[] = [];
    flattenPlus(expr, operands);
    const first = literal(operands[0]);
    if (!first) return undefined;
    return operands.map(op => literal(op) ?? '*').join('');
  }
  return undefined;
}

/** Check whether `node` is `import.meta.url`. */
function isImportMetaUrl(node: EsNode | undefined): boolean {
  const expr = unwrap(node);
  if (expr?.type !== 'MemberExpression') return false;
  const obj = unwrap(child(expr, 'object'));
  if (obj?.type !== 'MetaProperty') return false;
  return nameOf(child(obj, 'meta')) === 'import'
    && nameOf(child(obj, 'property')) === 'meta'
    && propertyName(expr) === 'url';
}

/** Check whether a `NewExpression` constructs `URL` or `globalThis.URL`. */
function isNewUrl(node: EsNode): boolean {
  const callee = unwrap(child(node, 'callee'));
  if (!callee) return false;
  if (callee.type === 'Identifier') return nameOf(callee) === 'URL';
  return callee.type === 'MemberExpression'
    && nameOf(unwrap(child(callee, 'object'))) === 'globalThis'
    && propertyName(callee) === 'URL';
}

/** Normalize WHATWG file-URL dot segments (`%2e`, `.%2e`, `%2e.`, `%2e%2e`, case-insensitive). */
function normalizeUrlSegment(segment: string): string {
  const lower = segment.toLowerCase();
  if (lower === '.' || lower === '%2e') return '.';
  if (lower === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') return '..';
  return segment;
}

/** Resolve a URL string against `file`'s `file:///` base and report if it leaves `folder`. */
function resolvedFileUrlEscape(spec: string, file: string, folder: string): RunnerFolderEscapeFinding | undefined {
  let resolved: URL;
  try {
    resolved = new URL(spec, `file:///${file}`);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== 'file:') return undefined;
  const folderRoot = `/${folder.slice(0, -1)}`;
  const inside = resolved.host === '' && (resolved.pathname === folderRoot || resolved.pathname.startsWith(`/${folder}`));
  if (inside) return undefined;
  const target = resolved.host ? `//${resolved.host}${resolved.pathname}` : resolved.pathname;
  return { kind: 'url', target };
}

/** Inspect `new URL(spec, import.meta.url)` and return its escape finding if it leaves `folder`. */
function checkNewUrl(node: EsNode, file: string, folder: string): RunnerFolderEscapeFinding | undefined {
  if (!isNewUrl(node)) return undefined;
  const args = children(node, 'arguments');
  if (args.length < 2 || !isImportMetaUrl(args[1])) return undefined;
  const raw = staticOrPrefixedText(args[0]);
  if (raw === undefined) return undefined;
  // WHATWG URL parser strips leading/trailing C0 controls/spaces and removes ASCII tab/CR/LF.
  const cleaned = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\r\n]/g, '');
  let relativeSpec = cleaned;
  if (URL_SCHEME.test(cleaned)) {
    if (!cleaned.toLowerCase().startsWith('file:')) return undefined;
    relativeSpec = cleaned.slice(5);
    if (relativeSpec.startsWith('/') || relativeSpec.startsWith('\\')) {
      return resolvedFileUrlEscape(cleaned, file, folder);
    }
  }
  const pathPart = (relativeSpec.split(/[?#]/, 1)[0] ?? '').replaceAll('\\', '/');
  if (pathPart.startsWith('/')) {
    return resolvedFileUrlEscape(cleaned, file, folder) ?? { kind: 'url', target: posix.resolve('/', pathPart) };
  }
  const segments = pathPart.split('/').map(normalizeUrlSegment);
  const target = escapedRelativeTarget(file, folder, segments);
  if (target !== undefined) return { kind: 'url', target };
  return resolvedFileUrlEscape(cleaned, file, folder);
}

/** Extract the literal specifier of a `TSImportType` node across ESTree field shapes. */
function tsImportTypeSpecifier(node: EsNode): string | undefined {
  const source = child(node, 'source') ?? child(node, 'argument');
  if (!source) return undefined;
  return source.type === 'TSLiteralType' ? stringOf(child(source, 'literal')) : stringOf(source);
}

/** Extract a static or static-prefix specifier from an import/export node. */
function specifierOfImportNode(node: EsNode): string | undefined {
  if (node.type === 'TSImportEqualsDeclaration') {
    const ref = child(node, 'moduleReference');
    return ref?.type === 'TSExternalModuleReference' ? stringOf(child(ref, 'expression')) : undefined;
  }
  if (node.type === 'TSImportType') return tsImportTypeSpecifier(node);
  if (node.type === 'ImportExpression') return staticOrPrefixedText(child(node, 'source'));
  return stringOf(child(node, 'source'));
}

/** Classify an import/export/require specifier into an escape finding, or `undefined` if allowed. */
export function classifySpecifier(file: string, specifier: string | undefined): RunnerFolderEscapeFinding | undefined {
  const folder = runnerFolderOf(file);
  if (!folder || specifier === undefined) return undefined;
  if (specifier.startsWith('.')) {
    const pathPart = specifier.split(/[?#]/, 1)[0] ?? '';
    const target = escapedRelativeTarget(file, folder, pathPart.split('/').map(normalizeUrlSegment));
    return target === undefined ? undefined : { kind: 'import', target };
  }
  return isAllowedPackageSpecifier(specifier) ? undefined : { kind: 'package', target: specifier };
}

/** Record imported aliases of `join`, `resolve`, `posix`, `win32`, or a `node:path*` namespace. */
function collectPathImports(node: EsNode, pathFns: Map<string, 'join' | 'resolve'>, pathNamespaces: Set<string>): void {
  if (node.importKind === 'type') return;
  const source = stringOf(child(node, 'source'));
  if (!source || !PATH_MODULES.has(source)) return;
  for (const spec of children(node, 'specifiers')) {
    const local = nameOf(child(spec, 'local'));
    if (!local) continue;
    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
      pathNamespaces.add(local);
    } else if (spec.type === 'ImportSpecifier' && spec.importKind !== 'type') {
      const imported = propertyName(child(spec, 'imported'));
      if (imported === 'join' || imported === 'resolve') pathFns.set(local, imported);
      else if (imported === 'posix' || imported === 'win32') pathNamespaces.add(local);
    }
  }
}

/** Whether `obj` is `path`, `posix`, `win32`, `path.posix`, `path.win32`, or an imported path namespace. */
function isPathNamespace(obj: EsNode | undefined, pathNamespaces: ReadonlySet<string>): boolean {
  if (!obj) return false;
  if (obj.type === 'Identifier') {
    const name = nameOf(obj);
    return name !== undefined && (DEFAULT_PATH_NAMESPACES.has(name) || pathNamespaces.has(name));
  }
  if (obj.type !== 'MemberExpression') return false;
  const rootName = nameOf(unwrap(child(obj, 'object')));
  const sub = propertyName(obj);
  return rootName !== undefined && (rootName === 'path' || pathNamespaces.has(rootName)) && (sub === 'posix' || sub === 'win32');
}

/** Whether `callee` is a recognized path `join` or `resolve` function or member. */
function pathCallMethod(callee: EsNode | undefined, pathFns: ReadonlyMap<string, 'join' | 'resolve'>, pathNamespaces: ReadonlySet<string>): 'join' | 'resolve' | undefined {
  const expr = unwrap(callee);
  if (!expr) return undefined;
  if (expr.type === 'Identifier') {
    const name = nameOf(expr);
    if (name === 'join' || name === 'resolve') return name;
    return name === undefined ? undefined : pathFns.get(name);
  }
  if (expr.type !== 'MemberExpression') return undefined;
  const method = propertyName(expr);
  if (!method || !PATH_JOIN_METHODS.has(method)) return undefined;
  return isPathNamespace(unwrap(child(expr, 'object')), pathNamespaces) ? (method as 'join' | 'resolve') : undefined;
}

/** Extract path segments from arguments of a `join`/`resolve` call, skipping a non-literal base. */
function pathCallSegments(args: readonly EsNode[], method: 'join' | 'resolve'): string[] | undefined {
  if (args.length === 0) return undefined;
  const firstText = staticOrPrefixedText(args[0]);
  if (firstText !== undefined && ABSOLUTE_PATH.test(firstText)) return undefined;
  const start = firstText === undefined ? 1 : 0;
  const segments: string[] = [];
  for (let i = start; i < args.length; i += 1) {
    const text = staticOrPrefixedText(args[i]);
    if (text === undefined) {
      segments.push('*');
      continue;
    }
    if (method === 'resolve' && ABSOLUTE_PATH.test(text)) return undefined;
    for (const part of text.split(/[/\\]+/)) {
      if (part !== '') segments.push(part);
    }
  }
  return segments.includes('..') ? segments : undefined;
}

/** Inspect a `join`/`resolve` call and return its escape finding if literal `'..'` climbs out. */
function checkPathCall(
  node: EsNode,
  file: string,
  folder: string,
  pathFns: ReadonlyMap<string, 'join' | 'resolve'>,
  pathNamespaces: ReadonlySet<string>,
): RunnerFolderEscapeFinding | undefined {
  const method = pathCallMethod(child(node, 'callee'), pathFns, pathNamespaces);
  if (!method) return undefined;
  const segments = pathCallSegments(children(node, 'arguments'), method);
  if (!segments) return undefined;
  const target = escapedRelativeTarget(file, folder, segments);
  return target === undefined ? undefined : { kind: 'path', target };
}

/** Inspect a bare `require('...')` call expression. */
function checkRequireCall(node: EsNode, file: string): RunnerFolderEscapeFinding | undefined {
  const callee = unwrap(child(node, 'callee'));
  if (callee?.type !== 'Identifier' || nameOf(callee) !== 'require') return undefined;
  const args = children(node, 'arguments');
  if (args.length !== 1) return undefined;
  return classifySpecifier(file, staticOrPrefixedText(args[0]));
}

interface CollectedSite {
  node: EsNode;
  kind: RunnerFolderEscapeKind;
  target: string;
}

const IMPORT_VISITORS = ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression', 'TSImportType', 'TSImportEqualsDeclaration'] as const;

/** Visitors that collect every escape site in `file` and pass them in source order to `done`. */
function collectVisitors(file: string, folder: string, done: (sites: readonly CollectedSite[]) => void): Visitors {
  const pathFns = new Map<string, 'join' | 'resolve'>();
  const pathNamespaces = new Set<string>();
  const sites: CollectedSite[] = [];
  const calls: EsNode[] = [];

  const record = (node: EsNode, finding: RunnerFolderEscapeFinding | undefined) => {
    if (finding) sites.push({ node, ...finding });
  };

  const inspectImport = (node: EsNode) => {
    if (node.type === 'ImportDeclaration') collectPathImports(node, pathFns, pathNamespaces);
    record(node, classifySpecifier(file, specifierOfImportNode(node)));
  };

  const visitors: Visitors = Object.fromEntries(IMPORT_VISITORS.map(type => [type, inspectImport]));
  visitors.NewExpression = (node: EsNode) => record(node, checkNewUrl(node, file, folder));
  visitors.CallExpression = (node: EsNode) => calls.push(node);
  visitors['Program:exit'] = () => {
    for (const call of calls) {
      record(call, checkRequireCall(call, file) ?? checkPathCall(call, file, folder, pathFns, pathNamespaces));
    }
    sites.sort((a, b) => offset(a.node) - offset(b.node));
    done(sites);
  };
  return visitors;
}

/** Read a runner's baseline entries from `<id>.baseline.json`, or `[]` when the file is absent. */
export function readRunnerFolderEscapeExceptions(runnerId: string, root = repoRoot): RunnerFolderEscapeException[] {
  const rel = runnerFolderEscapeBaselineFile(runnerId);
  const path = join(root, rel);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed?.entries)) throw new Error(`${rel}: expected { "entries": [...] }`);
  return parsed.entries as RunnerFolderEscapeException[];
}

/** Whether `runnerId`'s baseline file still holds any escape entry (used by the copy-out test). */
export function hasRunnerFolderEscapeBaselineEntries(runnerId: string, root = repoRoot): boolean {
  return readRunnerFolderEscapeExceptions(runnerId, root).length > 0;
}

const cachedByRunner = new Map<string, readonly RunnerFolderEscapeException[]>();

function cachedExceptions(runnerId: string): readonly RunnerFolderEscapeException[] {
  let entries = cachedByRunner.get(runnerId);
  if (!entries) {
    entries = readRunnerFolderEscapeExceptions(runnerId);
    cachedByRunner.set(runnerId, entries);
  }
  return entries;
}

const allowance = (exceptions: readonly RunnerFolderEscapeException[], file: string, kind: RunnerFolderEscapeKind, target: string) =>
  exceptions.find(entry => entry.file === file && entry.kind === kind && entry.target === target)?.count ?? 0;

/** All escape findings in `file` in source order, parsed with oxlint's parser. */
export function runnerFolderEscapes(file: string, source: string): RunnerFolderEscapeFinding[] {
  const folder = runnerFolderOf(file);
  if (!folder || !applies(file)) return [];
  let found: RunnerFolderEscapeFinding[] = [];
  scanSource(file, source, () => collectVisitors(file, folder, (sites) => {
    found = sites.map(({ kind, target }) => ({ kind, target }));
  }));
  return found;
}

/** Escapes beyond what `exceptions` allows for `file`. */
export function scanRunnerFolderEscapes(
  file: string,
  source: string,
  exceptions?: readonly RunnerFolderEscapeException[],
): RunnerFolderEscapeFinding[] {
  const id = runnerIdOf(file);
  if (!id || !applies(file)) return [];
  const list = exceptions ?? cachedExceptions(id);
  const seen = new Map<string, number>();
  return runnerFolderEscapes(file, source).filter(({ kind, target }) => {
    const key = `${kind}\n${target}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > allowance(list, file, kind, target);
  });
}

function messageFor(kind: RunnerFolderEscapeKind, target: string, folder: string): string {
  switch (kind) {
    case 'url':
      return `A runner folder must stay self-contained: new URL(..., import.meta.url) resolves to ${target}, outside ${folder}. Keep runner assets inside ${folder} or use @hearsay-tools/squawk/plugin (hearsay-tools/squawk#4255).`;
    case 'path':
      return `A runner folder must stay self-contained: this path join/resolve climbs out of ${folder} to ${target}. Keep runner assets inside ${folder} or use @hearsay-tools/squawk/plugin (hearsay-tools/squawk#4255).`;
    case 'import':
      return `A runner folder must stay self-contained: relative import resolves to ${target}, outside ${folder}. Import core APIs from @hearsay-tools/squawk/plugin or keep the code inside ${folder} (hearsay-tools/squawk#4255).`;
    case 'package':
      return `A runner folder must stay self-contained: package ${target} is not allowed here. Import only node:* built-ins, @hearsay-tools/squawk/plugin*, or files inside ${folder} (hearsay-tools/squawk#4255).`;
  }
}

/** Visitors for `file`, letting pass the escapes listed in `exceptions`. */
export function runnerFolderEscapeVisitors(
  report: Report,
  file: string,
  exceptions?: readonly RunnerFolderEscapeException[],
): Visitors {
  const id = runnerIdOf(file);
  const folder = runnerFolderOf(file);
  if (!id || !folder) return {};
  const list = exceptions ?? cachedExceptions(id);
  return collectVisitors(file, folder, (sites) => {
    const seen = new Map<string, number>();
    for (const { node, kind, target } of sites) {
      const key = `${kind}\n${target}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > allowance(list, file, kind, target)) report(node, messageFor(kind, target, folder));
    }
  });
}

function validateBaselineFile(root: string, runnerId: string, rel: string, fileCache: Map<string, RunnerFolderEscapeFinding[]>): string[] {
  let entries: RunnerFolderEscapeException[];
  try {
    entries = readRunnerFolderEscapeExceptions(runnerId, root);
  } catch (error) {
    return [`${rel} cez/runner-folder-escape: invalid baseline file (${error instanceof Error ? error.message : String(error)})`];
  }
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const file = typeof entry?.file === 'string' ? entry.file : '';
    const kind = entry?.kind;
    const target = typeof entry?.target === 'string' ? entry.target : '';
    const count = entry?.count;
    const key = `${file}\n${kind}\n${target}`;
    const valid = applies(file)
      && runnerIdOf(file) === runnerId
      && VALID_KINDS.has(kind)
      && target.length > 0
      && Number.isInteger(count)
      && count > 0
      && !seen.has(key);
    seen.add(key);
    let actual = 0;
    if (applies(file)) {
      let findings = fileCache.get(file);
      if (!findings) {
        const full = join(root, file);
        findings = existsSync(full) ? runnerFolderEscapes(file, readFileSync(full, 'utf8')) : [];
        fileCache.set(file, findings);
      }
      actual = findings.filter(item => item.kind === kind && item.target === target).length;
    }
    return valid && actual === count ? [] : [
      `${rel} cez/runner-folder-escape: stale or invalid entry ${file} [${String(kind)}] → ${target} (lists ${String(count)}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

/**
 * Stale, duplicate, misfiled, or invalid baseline entries under `runner-folder-escape/`, plus
 * missing baseline files for bundled runners present under `root`.
 */
export function staleRunnerFolderEscapes(root = repoRoot): string[] {
  const dir = join(root, runnerFolderEscapeBaselineDir);
  if (!existsSync(dir)) {
    return [`${runnerFolderEscapeBaselineDir} cez/runner-folder-escape: baseline directory is missing`];
  }
  const problems: string[] = [];
  const files = readdirSync(dir).filter(name => name.endsWith('.baseline.json')).sort();
  const runnersRoot = join(root, RUNNERS_DIR);
  if (existsSync(runnersRoot)) {
    for (const id of bundledRunnerIds(runnersRoot)) {
      if (!files.includes(`${id}.baseline.json`)) {
        problems.push(`${runnerFolderEscapeBaselineFile(id)} cez/runner-folder-escape: missing baseline file for bundled runner ${id}`);
      }
    }
  }
  const fileCache = new Map<string, RunnerFolderEscapeFinding[]>();
  for (const name of files) {
    const id = name.slice(0, -'.baseline.json'.length);
    problems.push(...validateBaselineFile(root, id, `${runnerFolderEscapeBaselineDir}/${name}`, fileCache));
  }
  return problems;
}

export const runnerFolderEscape: AstRule = {
  name: 'runner-folder-escape',
  description: 'A runner folder stays self-contained: no relative path escaping the folder and no package import outside node:* and @hearsay-tools/squawk/plugin* (hearsay-tools/squawk#4255).',
  applies,
  create: (report, { file }) => runnerFolderEscapeVisitors(report, file),
};
