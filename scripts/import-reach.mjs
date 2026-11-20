#!/usr/bin/env node
// Which test files load a module at runtime, through which importers, and at what cost
// (hearsay-tools/squawk#3974). It reads the checkout's files only: no Squeal daemon or store.
//
//   node scripts/import-reach.mjs <module>                    count, cost and ranked direct importers
//   node scripts/import-reach.mjs <module> --files <test>…    per test file: the shortest import chain, or OK
//   node scripts/import-reach.mjs <module> --json             the same report as JSON
//
// Edges it follows: value imports, `export … from`, side-effect imports, `import('literal')` and
// `require('literal')`. Edges it leaves out: `import type`, `export type`, a specifier list that
// is all `type`, `vi.mock`, and, outside packages/web, a value import whose names are used only
// as types (TypeScript removes it). Workspace package names resolve through each package.json
// `exports`, and `paths` in a package's tsconfig.json resolve too.
// A test file also loads the `setupFiles` of the nearest vitest.config that includes it.
//
// Costs: `tests` counts the test() and it() call sites (it.each, it.runIf and other modifiers
// included; .skip and .todo left out) in each test file that loads the module, at least one per
// file, so a split-out file that no longer loads it lowers the cost. `ci-ms` sums the per-file
// medians in .github/test-durations.json; files CI has not timed are counted.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, matchesGlob, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { parse } = createRequire(import.meta.url)('@babel/parser');

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
export const TEST_FILE = /\.(?:test|e2e)\.(?:[cm]?[jt]s|tsx|jsx)$/;
const BROWSER = /\.e2e\.(?:[cm]?[jt]s|tsx|jsx)$/;
const TYPE_NODE = /^TS(?!AsExpression|SatisfiesExpression|NonNullExpression|TypeAssertion|InstantiationExpression|ParameterProperty|EnumDeclaration|ModuleBlock|ExportAssignment|ImportEqualsDeclaration|ExternalModuleReference)/;
const SKIPPED_KEYS = new Set(['loc', 'extra', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeParameters', 'implements']);
const TEST_CALLEES = new Set(['test', 'it']);
const TEST_MODIFIERS = new Set(['only', 'concurrent', 'fails', 'sequential']);
// A curried modifier returns the function that registers the test: it.each(rows)('name', fn).
const TEST_CURRIED = new Set(['each', 'for', 'runIf', 'skipIf']);
const SKIPPED_TESTS = new Set(['skip', 'todo']);
const VITEST_CONFIG = /(?:^|\/)vitest\.config\.[cm]?[jt]s$/;

/** Removes comments and trailing commas from tsconfig-style JSON, leaving strings intact. */
export function parseJsonc(text) {
  const tokens = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  const stripped = text.replace(tokens, (token) => (token.startsWith('"') ? token : ''));
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'));
}

/** Tracked and untracked, not ignored files that exist, so a new split file counts before its commit. */
function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return new Set(out.split('\n').filter((f) => f && existsSync(join(root, f))));
}

/** The workspace packages: directory, name, `exports` and tsconfig `paths`. */
function workspacePackages(root, files) {
  const packages = [];
  for (const manifest of files) {
    if (!/^packages\/[^/]+\/package\.json$/.test(manifest)) continue;
    const dir = posix.dirname(manifest);
    const { name, exports } = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
    const tsconfig = `${dir}/tsconfig.json`;
    const options = files.has(tsconfig) ? parseJsonc(readFileSync(join(root, tsconfig), 'utf8')).compilerOptions ?? {} : {};
    packages.push({ dir, name, exports: typeof exports === 'string' ? { '.': exports } : exports ?? {}, paths: options.paths ?? {}, baseUrl: options.baseUrl ?? '.' });
  }
  return packages;
}

function exportTarget(value) {
  if (typeof value === 'string' || value === null) return value;
  return exportTarget(value?.import ?? value?.default ?? null);
}

/** The target of `subpath` in an `exports` map, with one `*` pattern; null when it is blocked or absent. */
export function matchExports(exports, subpath) {
  if (Object.hasOwn(exports, subpath)) return exportTarget(exports[subpath]);
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*');
    if (star === -1 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue;
    const target = exportTarget(value);
    return target === null ? null : target.replace('*', subpath.slice(star, subpath.length - (key.length - star - 1)));
  }
  return null;
}

function matchPaths(pkg, spec) {
  for (const [key, targets] of Object.entries(pkg.paths)) {
    const star = key.indexOf('*');
    const hit = star === -1 ? spec === key : spec.startsWith(key.slice(0, star)) && spec.endsWith(key.slice(star + 1));
    if (!hit) continue;
    const middle = star === -1 ? '' : spec.slice(star, spec.length - (key.length - star - 1));
    return targets.map((t) => posix.normalize(posix.join(pkg.dir, pkg.baseUrl, t.replace('*', middle))));
  }
  return [];
}

/** Resolves import specifiers to repository files. */
export function createResolver(files, packages) {
  const has = (f) => files.has(f);
  const tryFile = (p) => {
    const base = p.replace(/\.(?:[cm]?js|jsx)$/, '');
    const candidates = [p, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}.json`, `${p}/index.ts`, `${p}/index.tsx`, `${p}/index.js`];
    return candidates.find(has) ?? null;
  };
  const fromPackage = (spec) => {
    const pkg = packages.find((p) => p.name && (spec === p.name || spec.startsWith(`${p.name}/`)));
    if (!pkg) return null;
    const target = matchExports(pkg.exports, `.${spec.slice(pkg.name.length)}`);
    if (target === null) return null;
    const path = posix.normalize(posix.join(pkg.dir, target));
    return tryFile(path) ?? tryFile(path.replace(`${pkg.dir}/dist/`, `${pkg.dir}/src/`));
  };
  const fromPaths = (from, spec) => {
    const pkg = packages.find((p) => from.startsWith(`${p.dir}/`));
    for (const candidate of pkg ? matchPaths(pkg, spec) : []) {
      const hit = tryFile(candidate);
      if (hit) return hit;
    }
    return null;
  };
  return (from, spec) => {
    if (spec.startsWith('node:')) return null;
    if (spec.startsWith('.')) return tryFile(posix.normalize(posix.join(posix.dirname(from), spec)));
    return fromPaths(from, spec) ?? fromPackage(spec);
  };
}

function parseSource(source, file) {
  const ts = /\.[cm]?tsx?$/.test(file);
  const jsx = file.endsWith('x') || !ts;
  const plugins = [ts ? 'typescript' : null, jsx ? 'jsx' : null, 'importAttributes', 'decorators'].filter(Boolean);
  try {
    return parse(source, { sourceType: 'unambiguous', errorRecovery: true, plugins });
  } catch {
    return null;
  }
}

const isNode = (v) => Boolean(v) && typeof v === 'object' && typeof v.type === 'string';

function childNodes(node, skipped) {
  const out = [];
  for (const key in node) {
    if (skipped.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) out.push(...value.filter(isNode));
    else if (isNode(value)) out.push(value);
  }
  return out;
}

// The child that holds a name, not a reference, when the node is not computed: `x.Hub`,
// `{ Hub: 1 }` and `class { Hub() {} }` do not use an import named Hub. A shorthand `{ Hub }`
// still does, through its value.
const NAME_KEYS = { MemberExpression: 'property', OptionalMemberExpression: 'property', ObjectProperty: 'key', ObjectMethod: 'key',
  ClassProperty: 'key', ClassMethod: 'key', ClassAccessorProperty: 'key', JSXAttribute: 'name', LabeledStatement: 'label' };

const typeOnly = (n) => TYPE_NODE.test(n.type) || n.type === 'ImportDeclaration' || (n.type === 'ExportNamedDeclaration' && n.exportKind === 'type');

/** Names used in value positions: an import whose names never appear here is type-only. */
function valueNames(ast) {
  const names = new Set();
  const stack = [ast.program];
  while (stack.length) {
    const n = stack.pop();
    if (typeOnly(n)) continue;
    if (n.type === 'ExportSpecifier') {
      if (n.exportKind !== 'type') names.add(n.local.name);
      continue;
    }
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') names.add(n.name);
    const nameKey = n.computed ? undefined : NAME_KEYS[n.type];
    stack.push(...childNodes(n, nameKey ? new Set([...SKIPPED_KEYS, nameKey]) : SKIPPED_KEYS));
  }
  return names;
}

function importSpecifier(statement, used, keepTypeUses) {
  const specs = statement.specifiers;
  if (statement.importKind === 'type' || (specs.length > 0 && specs.every((s) => s.importKind === 'type'))) return null;
  const values = specs.filter((s) => s.importKind !== 'type');
  if (specs.length > 0 && !keepTypeUses && values.every((s) => !used.has(s.local.name))) return null;
  return statement.source.value;
}

function reExportSpecifier(statement) {
  if (!statement.source || statement.exportKind === 'type') return null;
  if (statement.type === 'ExportNamedDeclaration' && statement.specifiers.length > 0 && statement.specifiers.every((s) => s.exportKind === 'type')) return null;
  return statement.source.value;
}

function loadSpecifier(node) {
  const callee = node.type === 'CallExpression' ? node.callee : null;
  const isLoad = node.type === 'ImportExpression' || callee?.type === 'Import' || (callee?.type === 'Identifier' && callee.name === 'require');
  if (!isLoad) return null;
  const arg = node.type === 'ImportExpression' ? node.source : node.arguments[0];
  if (arg?.type === 'StringLiteral') return arg.value;
  if (arg?.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return null;
}

/** The root name and property names of a callee, through member access and calls:
 *  `it.runIf(c).each(rows)` gives ['it', 'runIf', 'each']; null for any other shape. */
function calleeChain(node) {
  const props = [];
  let n = node;
  while (n.type === 'CallExpression' || (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier')) {
    if (n.type === 'MemberExpression') props.unshift(n.property.name);
    n = n.type === 'CallExpression' ? n.callee : n.object;
  }
  return n.type === 'Identifier' ? [n.name, ...props] : null;
}

const lastProperty = (node) => (node.type === 'MemberExpression' ? node.property.name : null);

/** A call that registers a test: test(), it(), modifier chains, and the last call of a curried
 *  form such as it.runIf(c).each(rows)(…); `.skip` and `.todo` are left out. A call that only
 *  returns the registering function, such as it.each(rows), is not one, so a table counts once. */
function isTestCall(node) {
  if (node.type !== 'CallExpression') return false;
  const chain = calleeChain(node.callee);
  if (!chain || !TEST_CALLEES.has(chain[0])) return false;
  if (chain.slice(1).some((p) => SKIPPED_TESTS.has(p) || !(TEST_MODIFIERS.has(p) || TEST_CURRIED.has(p)))) return false;
  const curried = node.callee.type === 'CallExpression';
  return TEST_CURRIED.has(lastProperty(curried ? node.callee.callee : node.callee)) === curried;
}

/** The runtime import specifiers of one source file, and its test call sites. */
export function scanSource(source, file) {
  const ast = parseSource(source, file);
  if (!ast) return { specifiers: [], tests: 0 };
  const keepTypeUses = file.startsWith('packages/web/') || !/\.[cm]?tsx?$/.test(file);
  const used = valueNames(ast);
  const specifiers = [];
  for (const s of ast.program.body) {
    const spec = s.type === 'ImportDeclaration' ? importSpecifier(s, used, keepTypeUses)
      : s.type === 'ExportNamedDeclaration' || s.type === 'ExportAllDeclaration' ? reExportSpecifier(s) : null;
    if (spec) specifiers.push(spec);
  }
  let tests = 0;
  const stack = [ast.program];
  while (stack.length) {
    const n = stack.pop();
    const spec = loadSpecifier(n);
    if (spec) specifiers.push(spec);
    if (isTestCall(n)) tests++;
    stack.push(...childNodes(n, new Set(['loc', 'extra'])));
  }
  return { specifiers, tests };
}

const stringsIn = (list) => [...(list ?? '').matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);

/** Each Vitest config's setup files and include globs, read from its literal `setupFiles` and
 *  `include` arrays. A setup file runs before every test file the config includes. */
function vitestSetups(root, files, resolveSpec) {
  const configs = [];
  for (const config of [...files].filter((f) => VITEST_CONFIG.test(f))) {
    const text = readFileSync(join(root, config), 'utf8');
    const setups = stringsIn(/setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1]).map((spec) => resolveSpec(config, spec.startsWith('.') ? spec : `./${spec}`)).filter(Boolean);
    if (setups.length === 0) continue;
    const include = stringsIn(/include:\s*\[([^\]]*)\]/.exec(text)?.[1]);
    configs.push({ dir: posix.dirname(config), setups, include });
  }
  return configs.sort((a, b) => b.dir.length - a.dir.length);
}

/** The setup files of the nearest Vitest config that includes `test`. */
function setupsFor(configs, test) {
  const config = configs.find((c) => c.dir === '.' || test.startsWith(`${c.dir}/`));
  if (!config) return [];
  const rel = config.dir === '.' ? test : test.slice(config.dir.length + 1);
  return config.include.length === 0 || config.include.some((glob) => matchesGlob(rel, glob)) ? config.setups : [];
}

/** Reads the checkout and builds import edges lazily, one file at a time. A test file also
 *  has an edge to each setup file of its Vitest config. */
export function createGraph(root) {
  const files = listFiles(root);
  const resolveSpec = createResolver(files, workspacePackages(root, files));
  const setups = vitestSetups(root, files, resolveSpec);
  const scans = new Map();
  const scan = (file) => {
    if (!scans.has(file)) {
      const source = CODE.test(file) && !/\.d\.[cm]?ts$/.test(file) ? readFileSync(join(root, file), 'utf8') : '';
      const { specifiers, tests } = source ? scanSource(source, file) : { specifiers: [], tests: 0 };
      const setupEdges = TEST_FILE.test(file) ? setupsFor(setups, file) : [];
      const edges = [...new Set([...specifiers.map((spec) => resolveSpec(file, spec)).filter(Boolean), ...setupEdges])];
      scans.set(file, { edges, tests });
    }
    return scans.get(file);
  };
  return { files, edges: (file) => scan(file).edges, tests: (file) => scan(file).tests };
}

/** The shortest import chain from `start` to `target`, or null when `start` does not load it. */
export function shortestPath(graph, start, target) {
  const prev = new Map([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (file === target) {
      const path = [];
      for (let f = target; f !== null; f = prev.get(f)) path.unshift(f);
      return path;
    }
    for (const next of graph.edges(file)) {
      if (prev.has(next)) continue;
      prev.set(next, file);
      queue.push(next);
    }
  }
  return null;
}

function closure(graph, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) for (const next of graph.edges(stack.pop())) if (!seen.has(next)) seen.add(next), stack.push(next);
  return seen;
}

function readDurations(root) {
  const file = join(root, '.github/test-durations.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).durationsMs ?? {} : {};
}

/** The test files that load `target`, their costs, and the direct importers ranked by test reach. */
export function reach(graph, target, durations = {}) {
  const tests = [...graph.files].filter((f) => TEST_FILE.test(f)).sort();
  const direct = [...graph.files].filter((f) => CODE.test(f) && graph.edges(f).includes(target));
  const byImporter = new Map(direct.map((f) => [f, { importer: f, testFiles: 0, tests: 0 }]));
  const reaching = [];
  for (const test of tests) {
    const seen = closure(graph, test);
    if (!seen.has(target)) continue;
    const weight = Math.max(1, graph.tests(test));
    reaching.push({ file: test, tests: weight, ciMs: durations[test] ?? null, browser: BROWSER.test(test) });
    for (const row of byImporter.values()) if (seen.has(row.importer)) row.testFiles++, row.tests += weight;
  }
  const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {
    module: target,
    testFiles: reaching.length,
    browserTestFiles: reaching.filter((r) => r.browser).length,
    tests: sum(reaching, 'tests'),
    ciMs: sum(reaching, 'ciMs'),
    untimedTestFiles: reaching.filter((r) => r.ciMs === null).length,
    importers: [...byImporter.values()].sort((a, b) => b.testFiles - a.testFiles || b.tests - a.tests || a.importer.localeCompare(b.importer)),
    reaching,
  };
}

function formatReach(r) {
  const lines = [
    `module: ${r.module}`,
    `test files that load it at runtime: ${r.testFiles} (browser *.e2e.*: ${r.browserTestFiles})`,
    `cost tests (test()/it() call sites, at least 1 per file): ${r.tests}`,
    `cost ci-ms (.github/test-durations.json medians): ${r.ciMs}; test files without a duration: ${r.untimedTestFiles}`,
    `direct importers, ranked by test files that load the module through them:`,
    'test files\ttests\timporter',
    ...r.importers.map((i) => `${i.testFiles}\t${i.tests}\t${i.importer}`),
  ];
  return lines.join('\n');
}

function formatPath(file, path, target) {
  return path ? `${file}: ${path.join(' → ')}` : `${file}: OK (does not load ${target})`;
}

function parseArgs(argv) {
  const args = { module: null, files: [], json: false };
  let inFiles = false;
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--files') inFiles = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (inFiles) args.files.push(arg);
    else if (args.module) throw new Error(`unexpected argument ${arg}`);
    else args.module = arg;
  }
  if (!args.module) throw new Error('usage: node scripts/import-reach.mjs <module> [--files <test>…] [--json]');
  return args;
}

export function main(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const rel = (p) => posix.normalize(resolve(cwd, p).slice(root.length + 1).split('\\').join('/'));
  const target = rel(args.module);
  const graph = createGraph(root);
  const files = args.files.map(rel);
  const missing = [target, ...files].find((file) => !graph.files.has(file));
  if (missing) throw new Error(`${missing} is not a file of this checkout`);
  if (files.length > 0) {
    const rows = files.map((file) => ({ file, path: shortestPath(graph, file, target) }));
    return args.json ? JSON.stringify({ module: target, files: rows }, null, 2) : rows.map((r) => formatPath(r.file, r.path, target)).join('\n');
  }
  const report = reach(graph, target, readDurations(root));
  return args.json ? JSON.stringify(report, null, 2) : formatReach(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`import-reach: ${error.message}\n`);
    process.exitCode = 1;
  }
}
