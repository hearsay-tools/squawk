/**
 * Records the wait-rule oracle (hearsay-tools/squawk#3774, slice 6b): what the text scanners of
 * main a78d9e79e reported for every cell of `src/lint/wait-matrix-cells.testkit.ts`. The scanners
 * are read from git at that commit, so this runs after they are deleted from the tree.
 *
 *   node packages/cezar/scripts/record-wait-oracle.ts [--out <dir>]
 *
 * It writes `src/lint/wait-matrix.oracle.json`, or the same file under `--out`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matrixCells, type Cell } from '../src/lint/wait-matrix-cells.testkit.ts';
import { encodeRows, digest, ORACLE_BASE } from '../src/lint/wait-matrix-oracle.testkit.ts';

interface Site { rule: string; line: number }
interface ServerScanner { scanFile(file: string, source: string): { sites: Site[]; errors: { line: number }[] } }
interface UnitScanner { scanSource(file: string, source: string): Site[] }

const packageDir = resolve(import.meta.dirname, '..');
const repo = resolve(packageDir, '../..');
const outIndex = process.argv.indexOf('--out');
const out = outIndex === -1 ? join(packageDir, 'src/lint') : resolve(process.argv[outIndex + 1] ?? '.');

/** The base commit's lint directory, extracted so its `.ts` imports resolve against each other. */
function baseScanners(): { dir: string; server: Promise<ServerScanner>; unit: Promise<UnitScanner> } {
  const dir = mkdtempSync(join(tmpdir(), 'wait-oracle-'));
  const archive = execFileSync('git', ['archive', ORACLE_BASE, 'packages/cezar/src/lint'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const lint = join(dir, 'packages/cezar/src/lint');
  // The unit scanner resolves @babel/parser from the package's node_modules.
  execFileSync('ln', ['-s', join(packageDir, 'node_modules'), join(dir, 'packages/cezar/node_modules')]);
  return {
    dir,
    server: import(pathToFileURL(join(lint, 'test-wait-discipline.ts')).href) as Promise<ServerScanner>,
    unit: import(pathToFileURL(join(lint, 'unit-wait-discipline.ts')).href) as Promise<UnitScanner>,
  };
}

/** One cell's findings as the oracle keeps them: `rule@line`, in report order; `error@line` for a scan error; `throws` for a crash. */
export function recordCell(cell: Cell, server: ServerScanner, unit: UnitScanner): string[] {
  if (cell.file.startsWith('packages/cezar/src/')) {
    const { sites, errors } = server.scanFile(cell.file.slice('packages/cezar/src/'.length), cell.code);
    return [...sites.map(site => `${site.rule}@${site.line}`), ...errors.map(error => `error@${error.line}`)];
  }
  try {
    return unit.scanSource(cell.file.slice('packages/web/src/'.length), cell.code).map(site => `${site.rule}@${site.line}`);
  } catch {
    return ['throws'];
  }
}

const scanners = baseScanners();
try {
  const [server, unit] = await Promise.all([scanners.server, scanners.unit]);
  mkdirSync(out, { recursive: true });
  const profiles: Record<string, { cells: number; digest: string; rows: string }> = {};
  for (const [profile, cells] of Object.entries(matrixCells())) {
    const rows = cells.map(cell => recordCell(cell, server, unit));
    profiles[profile] = { cells: cells.length, digest: digest(cells), rows: encodeRows(rows) };
    console.log(`${profile}: ${cells.length} cells, ${rows.filter(row => row.length > 0).length} with findings`);
  }
  writeFileSync(join(out, 'wait-matrix.oracle.json'), `${JSON.stringify({ base: ORACLE_BASE, profiles }, null, 1)}\n`);
} finally {
  rmSync(scanners.dir, { recursive: true, force: true });
}
