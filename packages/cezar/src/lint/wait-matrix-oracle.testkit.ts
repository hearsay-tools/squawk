import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Cell } from './wait-matrix-cells.testkit.ts';

/** The main commit whose text scanners the oracle records. */
export const ORACLE_BASE = 'a78d9e79e7e678099456e6f733b70f595edee09b';

/** One letter per finding kind, so a row stays a few bytes: `s5` is a sleep at line 5. */
const LETTERS: Record<string, string> = { sleep: 's', 'short-bound': 'b', 'poll-deadline': 'p', error: 'e', throws: 't' };
const KINDS = Object.fromEntries(Object.entries(LETTERS).map(([kind, letter]) => [letter, kind]));

/** A digest of every cell's id, file and code, in order: a changed generator cannot reuse an old oracle. */
export function digest(cells: readonly Cell[]): string {
  const hash = createHash('sha256');
  for (const cell of cells) hash.update(`${cell.id}\0${cell.file}\0${cell.code}\0`);
  return hash.digest('hex');
}

/**
 * Rows as one gzipped, base64 string, so the oracle stays a few kilobytes: a row's findings joined
 * by `,`, rows joined by `;`, and a run of empty rows written as `~<count>;`. `rule@line` becomes
 * `<letter><line>`; `throws` is `t`.
 */
export function encodeRows(rows: readonly string[][]): string {
  const encoded = rows.map(row => row.map(finding => {
    if (finding === 'throws') return 't';
    const [kind = '', line = ''] = finding.split('@');
    const letter = LETTERS[kind];
    if (letter === undefined) throw new Error(`unknown finding ${finding}`);
    return `${letter}${line}`;
  }).join(','));
  let text = '';
  for (let i = 0; i < encoded.length;) {
    let run = 0;
    while (encoded[i + run] === '') run += 1;
    text += run > 1 ? `~${run};` : `${encoded[i]};`;
    i += Math.max(run, 1);
  }
  return gzipSync(text, { level: 9 }).toString('base64');
}

/** The rows `encodeRows` wrote, back as `rule@line` lists. */
export function decodeRows(packed: string): string[][] {
  const rows: string[][] = [];
  for (const row of gunzipSync(Buffer.from(packed, 'base64')).toString('utf8').split(';').slice(0, -1)) {
    if (row.startsWith('~')) {
      for (let i = 0; i < Number(row.slice(1)); i += 1) rows.push([]);
      continue;
    }
    rows.push(row === '' ? [] : row.split(',').map(finding => (finding === 't' ? 'throws' : `${KINDS[finding[0] ?? ''] ?? '?'}@${finding.slice(1)}`)));
  }
  return rows;
}
