import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AstRule } from './ast-rule.ts';
import { matrixProfile, type Cell } from './wait-matrix-cells.testkit.ts';
import { decodeRows, digest, ORACLE_BASE } from './wait-matrix-oracle.testkit.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';
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

/**
 * The wait-rule matrix against its oracle (hearsay-tools/squawk#3774, slice 6b). The oracle is what
 * the text scanners of main reported for every generated cell; `scripts/record-wait-oracle.ts`
 * writes it. A changed generator needs a new oracle, so each profile pins the digest of its cells.
 */
interface OracleFile { base: string; profiles: Record<string, { cells: number; digest: string; rows: string }> }

const file = JSON.parse(readFileSync(join(import.meta.dirname, 'wait-matrix.oracle.json'), 'utf8')) as OracleFile;
const oracle = (profile: string) => file.profiles[profile] ?? { cells: 0, digest: '', rows: '' };

/** Each cell's findings through oxlint, in the oracle's order: by line, then by rule. */
function findings(cells: readonly Cell[]): string[][] {
  const rule = cells[0]?.file.startsWith('packages/cezar/src/') ? testWaitDiscipline : unitWaitDiscipline;
  const byLine = (finding: string): [number, string] => [Number(finding.split('@')[1]), finding.split('@')[0] ?? ''];
  return lintCells(rule, cells).map(row => [...row].sort((a, b) => byLine(a)[0] - byLine(b)[0] || byLine(a)[1].localeCompare(byLine(b)[1])));
}

/** Cells one oracle case lints. A case that lints a whole profile ran near the 30 s per-test bound in CI (hearsay-tools/squawk#3798). */
const SLICE = 2500;

/** The cases of one profile: its oracle covers today's cells, and the rules report what it recorded, one slice of cells per case. One file per profile keeps each under the file duration cap. */
export function matrixSuite(profile: string): void {
  describe(`the wait-rule matrix: ${profile}`, () => {
    const cells = matrixProfile(profile);
    it(`${profile}: the oracle covers today's cells`, () => {
      const recorded = oracle(profile);
      expect(file.base).toBe(ORACLE_BASE);
      expect({ cells: recorded.cells, digest: recorded.digest }).toEqual({ cells: cells.length, digest: digest(cells) });
      expect(decodeRows(recorded.rows)).toHaveLength(cells.length);
    });

    let rows: string[][] | undefined;
    const slices = Array.from({ length: Math.ceil(cells.length / SLICE) }, (_, index) => {
      const start = index * SLICE;
      const end = Math.min(cells.length, start + SLICE);
      return [`${start}-${end}`, start, end] as const;
    });
    it.each(slices)(`${profile}: the rules report what the oracle recorded for cells %s`, (_name, start, end) => {
      rows ??= decodeRows(oracle(profile).rows);
      const recorded = rows;
      const slice = cells.slice(start, end);
      const linted = findings(slice);
      const differences = slice.flatMap((cell, index) => {
        const actual = linted[index] ?? [];
        return actual.join(',') === recorded[start + index]?.join(',') ? [] : [{ id: cell.id, expected: recorded[start + index], actual }];
      });
      expect(differences.slice(0, 20)).toEqual([]);
    });
  });
}
