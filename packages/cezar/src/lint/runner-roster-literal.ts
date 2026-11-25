import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { children, type AstRule } from './ast-rule.ts';
import { literal } from './ast-syntax.ts';
import { visit } from './babel-walk.ts';
import { declaredRunnerIds, literalText, parserPlugins } from './runner-id-branch.ts';
import { repoRoot } from './source-rule.ts';

/**
 * The bundled runner folders (`runners/<id>/` with a plugin entry, read by
 * `plugin/bundled-runners.ts`) are the one roster of runner ids. A list written by hand keeps
 * compiling when a runner is added, and that runner is then missing from one seam
 * (open-mercato/cezar#387).
 *
 * Static scope: every JS and TS file under `packages/`, tests included. The rule reports an array literal whose string elements name every id of the
 * roster, in any order and with any other element beside them.
 *
 * It leaves out a list that omits a runner (a deliberate subset), a roster spelled as a union
 * type, as object keys or as separate arguments, and a list built from parts. An object typed
 * over the roster's ids needs no rule: the compiler refuses a missing key.
 *
 * `runner-roster-literal.baseline.json` lists the files that keep a roster, each with its count
 * and a reason. It only shrinks: `npm run lint` fails a stale entry, and CI's baseline-growth
 * gate refuses a new one.
 */
export const runnerRostersFile = 'packages/cezar/src/lint/runner-roster-literal.baseline.json';

let declared: string[] | undefined;

/** Where each hand-written full roster starts in `source`. */
export function runnerRosters(file: string, source: string, ids: readonly string[] = (declared ??= declaredRunnerIds())): number[] {
  // A roster quotes every id; most files do not and are not parsed.
  if (!ids.every(id => ['\'', '"', '`'].some(quote => source.includes(`${quote}${id}${quote}`)))) return [];
  const ast = parse(source, { sourceType: 'module', plugins: parserPlugins(file) });
  const offsets: number[] = [];
  visit(ast.program, (node) => {
    if (node.type !== 'ArrayExpression') return;
    const named = new Set(node.elements.map(element => (element ? literalText(element) : undefined)));
    if (ids.every(id => named.has(id))) offsets.push(node.start ?? 0);
  });
  return offsets;
}

/** A file that keeps `count` hand-written rosters. */
export interface RunnerRosterException { file: string; count: number; reason: string }

export function readRunnerRosterExceptions(path = join(repoRoot, runnerRostersFile)): RunnerRosterException[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: RunnerRosterException[] }).entries;
}

let listed: RunnerRosterException[] | undefined;

/** The rosters beyond what the list allows for the file. */
export function scanRunnerRosters(file: string, source: string, exceptions = (listed ??= readRunnerRosterExceptions())): number[] {
  return runnerRosters(file, source).slice(exceptions.find(entry => entry.file === file)?.count ?? 0);
}

const applies = (file: string) => /^packages\/.+\.[cm]?[jt]sx?$/.test(file);

/** Entries that allow more than the file still has, repeat another entry, or give no reason. */
export function staleRunnerRosters(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readRunnerRosterExceptions(join(root, runnerRostersFile)).flatMap((entry) => {
    const path = join(root, entry.file);
    const actual = existsSync(path) ? runnerRosters(entry.file, readFileSync(path, 'utf8')).length : 0;
    const valid = applies(entry.file) && Number.isInteger(entry.count) && entry.count > 0 && entry.reason.trim() !== '' && !seen.has(entry.file);
    seen.add(entry.file);
    return valid && actual === entry.count ? [] : [
      `${runnerRostersFile} cez/runner-roster-literal: stale or invalid entry ${entry.file} (lists ${entry.count}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

export const runnerRosterLiteral: AstRule = {
  name: 'runner-roster-literal',
  description: 'The bundled runner folders are the one roster of runner ids; no array literal lists every runner id (open-mercato/cezar#387).',
  applies,
  create(report, { file }) {
    const ids = declared ??= declaredRunnerIds();
    let remaining = (listed ??= readRunnerRosterExceptions()).find(entry => entry.file === file)?.count ?? 0;
    return {
      ArrayExpression(node) {
        const named = new Set(children(node, 'elements').map(element => literal(element)));
        if (ids.every(id => named.has(id)) && remaining-- <= 0) report(node, "This array lists every runner id by hand, so a new runner would be missing here. Read the registry (registeredRunners in packages/cezar/src/core/runner-registry.ts), or in a test BUILT_IN_RUNNER_IDS from packages/cezar/src/core/built-in-runner-ids.testkit.ts; a Node-free package reads the runners from GET /api/v1/runners (open-mercato/cezar#387).");
      },
    };
  },
};
