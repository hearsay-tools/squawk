import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { AstRule, EsNode, Report, Visitors } from './ast-rule.ts';
import { IMPORT_NODE_TYPES, importSpecifier, relativeSpecifiers } from './layer-import.ts';
import { repoRoot } from './source-rule.ts';

/**
 * A runner folder reads core code only through the runner kit, `@hearsay-tools/squawk/plugin`
 * (`plugin/runner-kit.ts`), so a runner can leave the package as a plugin
 * (spec 2026-11-24-plugin-loader-and-runner-kit § 3, hearsay-tools/squawk#4201).
 *
 * Static scope: non-test `.ts` files under `packages/cezar/src/runners/<folder>/`, every folder
 * but `fixture/`; tests, testkits, `.d.ts` files and `__fixtures__/` stay out. The rule reads the
 * relative specifier of each `import` and `export … from` declaration (type-only ones included), a
 * literal `import()`, a literal `import('…')` type and an `import x = require('…')`, maps `.js` to
 * `.ts`, and reports one that resolves outside the file's own runner folder. A package specifier,
 * such as `@hearsay-tools/squawk/plugin`, and a computed specifier are out of scope.
 *
 * `runner-core-import.baseline.json` lists the outside imports the rule lets pass, each by
 * importing file, imported file and count. It only shrinks: `npm run lint` fails a stale entry,
 * and CI's baseline-growth gate refuses a new one. The runner migrations drain it to no entries.
 */
export const runnerCoreImportBaselineFile = 'packages/cezar/src/lint/runner-core-import.baseline.json';
const RUNNERS = 'packages/cezar/src/runners/';
const SHARED_FOLDERS = new Set(['fixture']);

/** The runner folder that holds `file`, such as `packages/cezar/src/runners/pi/`, or `undefined`. */
export function runnerFolder(file: string): string | undefined {
  if (!file.startsWith(RUNNERS)) return undefined;
  const [folder, ...rest] = file.slice(RUNNERS.length).split('/');
  if (!folder || rest.length === 0 || SHARED_FOLDERS.has(folder)) return undefined;
  return `${RUNNERS}${folder}/`;
}

const applies = (file: string): boolean =>
  runnerFolder(file) !== undefined && file.endsWith('.ts') && !/\.(?:test|testkit|d)\.ts$/.test(file) && !/(?:^|\/)__fixtures__\//.test(file);

const PRIVATE_CONTRACT = /^@open-mercato\/cezar-contract(?:\/|$)/;

/** The repository path (or private workspace contract specifier) that `specifier`, written in `file`, names when it leaves the runner folder. */
export function outsideTarget(file: string, specifier: string | undefined): string | undefined {
  const folder = runnerFolder(file);
  if (!folder || !specifier) return undefined;
  if (PRIVATE_CONTRACT.test(specifier)) return specifier;
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.join(posix.dirname(file), specifier).replace(/\.js$/, '.ts');
  return target.startsWith(folder) ? undefined : target;
}

/** The outside targets of `file`, one per import, in source order. */
export function runnerCoreImports(file: string, source: string): string[] {
  if (!applies(file)) return [];
  const relative = relativeSpecifiers(source).flatMap(({ specifier }) => outsideTarget(file, specifier) ?? []);
  const contracts = [...source.matchAll(/from\s+['"](@open-mercato\/cezar-contract(?:\/[^'"]*)?)['"]/g)].map(m => m[1]!);
  return [...relative, ...contracts];
}

/** Outside imports the rule lets pass `count` times from `file` to `target`, both repository paths. */
export interface RunnerCoreImportException { file: string; target: string; count: number }

export function readRunnerCoreImportExceptions(path = join(repoRoot, runnerCoreImportBaselineFile)): RunnerCoreImportException[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: RunnerCoreImportException[] }).entries;
}

let listed: RunnerCoreImportException[] | undefined;

const allowance = (exceptions: readonly RunnerCoreImportException[], file: string, target: string) =>
  exceptions.find(entry => entry.file === file && entry.target === target)?.count ?? 0;

/** The outside imports beyond what the baseline allows: of each target, the ones after its allowed count. */
export function scanRunnerCoreImports(file: string, source: string, exceptions = (listed ??= readRunnerCoreImportExceptions())): string[] {
  const seen = new Map<string, number>();
  return runnerCoreImports(file, source).filter((target) => {
    const count = (seen.get(target) ?? 0) + 1;
    seen.set(target, count);
    return count > allowance(exceptions, file, target);
  });
}

/** Baseline entries whose count differs from the file's imports of that target, or that repeat another entry. */
export function staleRunnerCoreImports(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readRunnerCoreImportExceptions(join(root, runnerCoreImportBaselineFile)).flatMap((entry) => {
    const path = join(root, entry.file);
    const actual = existsSync(path) ? runnerCoreImports(entry.file, readFileSync(path, 'utf8')).filter(target => target === entry.target).length : 0;
    const key = `${entry.file}\n${entry.target}`;
    const valid = applies(entry.file) && Number.isInteger(entry.count) && entry.count > 0 && !seen.has(key);
    seen.add(key);
    return valid && actual === entry.count ? [] : [
      `${runnerCoreImportBaselineFile} cez/runner-core-import: stale or invalid entry ${entry.file} → ${entry.target} (lists ${entry.count}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

const message = (target: string, folder: string) =>
  `A runner reads core code only through the runner kit: import from @hearsay-tools/squawk/plugin (packages/cezar/src/plugin/runner-kit.ts), not ${target}, or keep the code inside ${folder} (hearsay-tools/squawk#4201).`;

/** The rule's visitors for `file`, which let pass the outside imports `exceptions` lists. */
export function runnerCoreImportVisitors(report: Report, file: string, exceptions = (listed ??= readRunnerCoreImportExceptions())): Visitors {
  const folder = runnerFolder(file);
  if (folder === undefined) return {};
  const seen = new Map<string, number>();
  const inspect = (node: EsNode) => {
    const target = outsideTarget(file, importSpecifier(node));
    if (target === undefined) return;
    const count = (seen.get(target) ?? 0) + 1;
    seen.set(target, count);
    if (count > allowance(exceptions, file, target)) report(node, message(target, folder));
  };
  return Object.fromEntries(IMPORT_NODE_TYPES.map(type => [type, inspect]));
}

export const runnerCoreImport: AstRule = {
  name: 'runner-core-import',
  description: 'A runner folder imports core code only through @hearsay-tools/squawk/plugin (hearsay-tools/squawk#4201).',
  applies,
  create: (report, { file }) => runnerCoreImportVisitors(report, file),
};
