import { parse } from '@babel/parser';
import { visit } from './home-boundary.ts';
import { declaredRunnerIds, literalText, parserPlugins } from './runner-id-branch.ts';
import { children, type AstRule } from './ast-rule.ts';
import { literal } from './ast-syntax.ts';

/**
 * A parity test selects the runners a row covers from what each runner declares: `runnersWhere()`
 * over `RUNNER_FACTS` in `core/runner-facts.ts`, or `exemptWhere()` in
 * `core/harness-parity-core.testkit.ts`. Then a changed facts row changes the expected result with
 * no per-runner test edit (hearsay-tools/squawk#3642). A group of runner ids written by hand keeps
 * its members when a row changes.
 *
 * Static scope: JS and TS files under `packages/` whose name contains `parity`. The rule reports an
 * array literal whose elements are all runner-id strings and that names two or more runner ids,
 * but not every id of `RUNNER_IDS`.
 *
 * It leaves out a list of one runner (a named single-runner exemption, or the runner of a
 * per-runner shard), an array that pairs a runner id with other values (a per-runner reason
 * table), a list of every runner (`cez/runner-roster-literal` owns it), and a list built from
 * parts or held in another file.
 */
let declared: string[] | undefined;

/** Where each hand-written group of runner ids starts in `source`. */
export function runnerSubsets(file: string, source: string, ids: readonly string[] = (declared ??= declaredRunnerIds())): number[] {
  // A group quotes at least two ids; a file that quotes fewer is not parsed.
  if (ids.filter(id => ['\'', '"', '`'].some(quote => source.includes(`${quote}${id}${quote}`))).length < 2) return [];
  const ast = parse(source, { sourceType: 'module', plugins: parserPlugins(file) });
  const offsets: number[] = [];
  visit(ast.program, (node) => {
    if (node.type !== 'ArrayExpression' || node.elements.length === 0) return;
    const named = node.elements.map(element => (element ? literalText(element) : undefined));
    if (!named.every(name => name !== undefined && ids.includes(name))) return;
    const distinct = new Set(named).size;
    if (distinct >= 2 && distinct < ids.length) offsets.push(node.start ?? 0);
  });
  return offsets;
}

const applies = (file: string) => /^packages\/.+\.[cm]?[jt]sx?$/.test(file) && /parity[^/]*$/.test(file);

export const parityRunnerSubset: AstRule = {
  name: 'parity-runner-subset',
  description: 'A parity test selects runners from their declared facts, not from a hand-written group of runner ids (hearsay-tools/squawk#3642).',
  applies,
  create(report) {
    const ids = declared ??= declaredRunnerIds();
    return {
      ArrayExpression(node) {
        const elements = node.elements as Array<unknown>;
        const named = children(node, 'elements').map(element => literal(element));
        if (named.length !== elements.length || !named.every(name => name !== undefined && ids.includes(name))) return;
        const distinct = new Set(named).size;
        if (distinct >= 2 && distinct < ids.length) report(node, "This array lists a group of runner ids by hand, so a changed facts row would not change it. Select the runners from what they declare: runnersWhere() over RUNNER_FACTS in packages/cezar/src/core/runner-facts.ts, or exemptWhere() in core/harness-parity-core.testkit.ts. A protocol quirk of one runner names that one runner (hearsay-tools/squawk#3642).");
      },
    };
  },
};
