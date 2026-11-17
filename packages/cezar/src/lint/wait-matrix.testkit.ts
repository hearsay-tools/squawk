import type { AstRule } from './ast-rule.ts';
import type { Cell } from './wait-matrix-cells.testkit.ts';
import { inOxlint } from './wait-oxlint.ts';

/** One finding of a wait rule: its rule, its line, and the site's line text the message names. */
export interface LintedSite {
  rule: string;
  line: number;
  site: string;
}

const REMEDIES = ['. A poll loop needs', ". Wait on the product's own signal", '. New wait-discipline sites'];

/** A wait rule's message, `[<rule>] <site>. <remedy>`, read back as its rule and site. */
function readMessage(message: string, line: number): LintedSite {
  const rule = /^\[([\w-]+)\] /.exec(message)?.[1] ?? message;
  const end = Math.max(...REMEDIES.map(remedy => message.lastIndexOf(remedy)));
  return { rule, line, site: message.slice(rule.length + 3, end) };
}

/**
 * Each cell's findings from one AST rule as oxlint runs it, in this process, in report order: the
 * rule's own scope, baseline and message included. `undefined` for a cell outside the rule's
 * scope or one oxlint cannot parse.
 */
export function lintSites(rule: AstRule, cells: ReadonlyArray<Pick<Cell, 'file' | 'code'>>): Array<LintedSite[] | undefined> {
  const found = new Map<string, LintedSite[]>();
  inOxlint(cells.filter(cell => rule.applies(cell.file)), context => {
    const findings: LintedSite[] = [];
    found.set(`${context.file}\0${context.sourceCode.text}`, findings);
    return rule.create((node, message, position) => {
      findings.push(readMessage(message, position?.line ?? (node.loc as { start: { line: number } }).start.line));
    }, context);
  });
  return cells.map(cell => found.get(`${cell.file}\0${cell.code}`));
}

/** Each cell's findings as `rule@line`; `parse-error` for a cell the rule did not read. */
export const lintCells = (rule: AstRule, cells: readonly Cell[]): string[][] =>
  lintSites(rule, cells).map(sites => (sites === undefined ? ['parse-error'] : sites.map(site => `${site.rule}@${site.line}`)));
