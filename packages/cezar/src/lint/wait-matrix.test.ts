import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matrixCells, type Cell } from './wait-matrix-cells.testkit.ts';
import { decodeRows, digest, ORACLE_BASE } from './wait-matrix-oracle.testkit.ts';
import { scanFile } from './test-wait-discipline.ts';
import { scanSource } from './unit-wait-discipline.ts';

/**
 * The wait-rule matrix against its oracle (hearsay-tools/squawk#3774, slice 6b). The oracle is what
 * the text scanners of main reported for every generated cell; `scripts/record-wait-oracle.ts`
 * writes it. A changed generator needs a new oracle, so each profile pins the digest of its cells.
 */
interface OracleFile { base: string; profiles: Record<string, { cells: number; digest: string; rows: string }> }

const file = JSON.parse(readFileSync(join(import.meta.dirname, 'wait-matrix.oracle.json'), 'utf8')) as OracleFile;
const oracle = (profile: string) => file.profiles[profile] ?? { cells: 0, digest: '', rows: '' };

function findings(cell: Cell): string[] {
  if (cell.file.startsWith('packages/cezar/src/')) {
    const { sites, errors } = scanFile(cell.file.slice('packages/cezar/src/'.length), cell.code);
    return [...sites.map(site => `${site.rule}@${site.line}`), ...errors.map(error => `error@${error.line}`)];
  }
  return scanSource(cell.file.slice('packages/web/src/'.length), cell.code).map(site => `${site.rule}@${site.line}`);
}

describe('the wait-rule matrix', () => {
  for (const [profile, cells] of Object.entries(matrixCells())) {
    it(`${profile}: the oracle covers today's cells`, () => {
      const recorded = oracle(profile);
      expect(file.base).toBe(ORACLE_BASE);
      expect({ cells: recorded.cells, digest: recorded.digest }).toEqual({ cells: cells.length, digest: digest(cells) });
      expect(decodeRows(recorded.rows)).toHaveLength(cells.length);
    });

    it(`${profile}: the scanners report what the oracle recorded`, () => {
      const rows = decodeRows(oracle(profile).rows);
      const differences = cells.flatMap((cell, index) => {
        const actual = findings(cell);
        return actual.join(',') === rows[index]?.join(',') ? [] : [{ id: cell.id, expected: rows[index], actual }];
      });
      expect(differences.slice(0, 20)).toEqual([]);
    });
  }
});
