import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matrixCells, type Cell } from './wait-matrix-cells.testkit.ts';
import { decodeRows, digest, ORACLE_BASE } from './wait-matrix-oracle.testkit.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';
import { lintCells } from './wait-matrix.testkit.ts';

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

describe('the wait-rule matrix', () => {
  for (const [profile, cells] of Object.entries(matrixCells())) {
    it(`${profile}: the oracle covers today's cells`, () => {
      const recorded = oracle(profile);
      expect(file.base).toBe(ORACLE_BASE);
      expect({ cells: recorded.cells, digest: recorded.digest }).toEqual({ cells: cells.length, digest: digest(cells) });
      expect(decodeRows(recorded.rows)).toHaveLength(cells.length);
    });

    it(`${profile}: the rules report what the oracle recorded`, () => {
      const rows = decodeRows(oracle(profile).rows);
      const linted = findings(cells);
      const differences = cells.flatMap((cell, index) => {
        const actual = linted[index] ?? [];
        return actual.join(',') === rows[index]?.join(',') ? [] : [{ id: cell.id, expected: rows[index], actual }];
      });
      expect(differences.slice(0, 20)).toEqual([]);
    });
  }
});
