import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { child, children, nameOf, stringOf, type AstContext, type AstRule, type EsNode, type Position } from './ast-rule.ts';
import { propertyName, unwrap } from './ast-syntax.ts';
import { repoRoot } from './source-rule.ts';

/**
 * A test that builds a calendar date from a literal or from `Date.now()` while the code under test
 * reads the real clock fails once the real day moves: a `2026-10-27` fixture left a 7-day lookback
 * (hearsay-tools/squawk#2537), and commits made just before midnight stopped counting as today
 * (hearsay-tools/squawk#4194).
 *
 * Static scope: `.test.*` and `.e2e.*` JS/TS files under `packages/`, except the lint rules'
 * own tests. The rule reports
 * - a string literal or a template part that starts with an ISO calendar date (`YYYY-MM-DD`);
 * - a `Date.now()` call that is an operand of `+` or `-` inside the first argument of `new Date(…)`.
 * A file that calls `setSystemTime(…)` or `useFakeTimers({ now: … })` on any object pins the clock
 * and passes; a bare `useFakeTimers()` starts at the real time and pins nothing. A file with a `// real-clock: <reason>` comment passes; the comment without a reason is reported.
 * The rule follows no value: it does not see a date built in a helper, held in a variable before
 * `new Date`, or kept as a number.
 *
 * `test-unpinned-clock-date.baseline.json` holds the files that had sites when the rule landed,
 * each with its site count. It only shrinks: a file with fewer sites than its count is reported
 * until the count is lowered, and CI's baseline-growth gate refuses a new or raised entry.
 */

export const clockDatesFile = 'packages/cezar/src/lint/test-unpinned-clock-date.baseline.json';

const LINT_DIR = 'packages/cezar/src/lint/';
const TEST_FILE = /\.(?:test|e2e)\.[cm]?[jt]sx?$/;
const ISO_DATE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/;
const REAL_CLOCK = /^\s*real-clock:/;
const REASONED = /^\s*real-clock:\s*\S/;
const ARITHMETIC = new Set(['+', '-']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']);

export const CLOCK_DATE_MESSAGE =
  'This test builds a calendar date from a literal or from Date.now() and never pins the clock, so it can fail ' +
  'when the real day changes. Pin the clock with vi.setSystemTime(<fixed time>) or vi.useFakeTimers({ now: <fixed time> }), ' +
  'or add // real-clock: <reason> to the file (hearsay-tools/squawk#4194).';
export const BARE_REAL_CLOCK_MESSAGE = '// real-clock: needs a reason after the colon (hearsay-tools/squawk#4194).';

const applies = (file: string) =>
  file.startsWith('packages/') && !file.startsWith(LINT_DIR) && !file.includes('/node_modules/') && TEST_FILE.test(file);

/** `Date.now()` with no argument. */
function isDateNow(node: EsNode): boolean {
  const callee = unwrap(child(node, 'callee'));
  return callee?.type === 'MemberExpression' && nameOf(child(callee, 'object')) === 'Date'
    && propertyName(callee) === 'now' && children(node, 'arguments').length === 0;
}

/** `new Date(Date.now() - ms)`: the call is a `+`/`-` operand inside `new Date`'s first argument. */
function feedsNewDate(call: EsNode): boolean {
  let node = call;
  let arithmetic = false;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (parent.type === 'BinaryExpression' && ARITHMETIC.has(parent.operator as string)) arithmetic = true;
    else if (!WRAPPERS.has(parent.type)) {
      return arithmetic && parent.type === 'NewExpression' && nameOf(child(parent, 'callee')) === 'Date'
        && children(parent, 'arguments')[0] === node;
    }
  }
  return false;
}

/**
 * `setSystemTime(…)`, or `useFakeTimers({ now: … })`. A bare `useFakeTimers()` starts the fake
 * clock at the real time, so it pins nothing.
 */
function isPin(node: EsNode): boolean {
  const callee = unwrap(child(node, 'callee'));
  if (callee?.type !== 'MemberExpression') return false;
  const name = propertyName(callee);
  if (name === 'setSystemTime') return true;
  const options = unwrap(children(node, 'arguments')[0]);
  return name === 'useFakeTimers' && options?.type === 'ObjectExpression'
    && children(options, 'properties').some(property => property.type === 'Property' && propertyName(child(property, 'key')) === 'now');
}

/** What one file holds: its date sites, whether it pins the clock, and its `real-clock` comments. */
export interface ClockDates { sites: EsNode[]; pinned: boolean; reasoned: boolean; bare: EsNode[] }

/** Visitors that collect a file's clock dates and hand them to `done` at the end of the file. */
export function clockDateVisitors(sourceCode: AstContext['sourceCode'], done: (found: ClockDates, program: EsNode) => void) {
  const sites: EsNode[] = [];
  let pinned = false;
  return {
    Literal(node: EsNode) {
      const text = stringOf(node);
      if (text !== undefined && ISO_DATE.test(text)) sites.push(node);
    },
    TemplateElement(node: EsNode) {
      const cooked = (node.value as { cooked?: unknown }).cooked;
      if (typeof cooked === 'string' && ISO_DATE.test(cooked)) sites.push(node);
    },
    CallExpression(node: EsNode) {
      if (isPin(node)) pinned = true;
      else if (isDateNow(node) && feedsNewDate(node)) sites.push(node);
    },
    'Program:exit'(program: EsNode) {
      const marks = sourceCode.getAllComments().filter(comment => typeof comment.value === 'string' && REAL_CLOCK.test(comment.value));
      const reasoned = marks.some(comment => REASONED.test(comment.value as string));
      done({ sites, pinned, reasoned, bare: marks.filter(comment => !REASONED.test(comment.value as string)) }, program);
    },
  };
}

/** The sites a file still leaves to the real clock: none once it pins the clock or gives a reason. */
export const openSites = ({ sites, pinned, reasoned }: ClockDates): EsNode[] => (pinned || reasoned ? [] : sites);

export function readClockDateBaseline(path = join(repoRoot, clockDatesFile)): Record<string, number> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, number> }).files;
}

const position = (node: EsNode): Position => {
  const { start } = node.loc as { start: Position };
  return { line: start.line, column: start.column };
};

/** The rule over `baseline`, the allowed site count per file; the repository's baseline by default. */
export function clockDateRule(baseline?: Record<string, number>): AstRule {
  let listed = baseline;
  return {
    name: 'test-unpinned-clock-date',
    description: 'A test that builds a calendar date pins the clock or says why it needs the real one (hearsay-tools/squawk#4194).',
    applies,
    create(report, { file, sourceCode }) {
      const allowed = (listed ??= readClockDateBaseline())[file] ?? 0;
      return clockDateVisitors(sourceCode, (found, program) => {
        for (const comment of found.bare) report(program, BARE_REAL_CLOCK_MESSAGE, position(comment));
        const open = openSites(found);
        for (const site of open.slice(allowed)) report(site, CLOCK_DATE_MESSAGE);
        if (open.length < allowed) {
          report(program, `${clockDatesFile} lists ${allowed} unpinned clock dates for this file, but it has ${open.length}. Lower the count, or remove the entry at 0.`, { line: 1, column: 0 });
        }
      });
    },
  };
}

export const testUnpinnedClockDate = clockDateRule();

/** Baseline entries whose file is gone or out of the rule's scope; oxlint reports the rest. */
export function staleClockDates(root = repoRoot): string[] {
  return Object.entries(readClockDateBaseline(join(root, clockDatesFile))).flatMap(([file, count]) =>
    applies(file) && existsSync(join(root, file)) && Number.isInteger(count) && count > 0 ? [] : [
      `${clockDatesFile} cez/test-unpinned-clock-date: stale or invalid entry ${file} (${count}); remove it`,
    ]);
}
