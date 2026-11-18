import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gitSync } from '../git-command.ts';
import { baselineMode, printLowered, type BaselineMode } from './baseline-mode.ts';

/**
 * Source files over 1,000 lines are pinned at their current length (hearsay-tools/cezarion#1800).
 *
 * A pinned file may not grow, and no other file may pass the limit. The baseline only shrinks: a local
 * `npm run lint` lowers the pin of a file that got smaller (`lint/baseline-mode.ts`), CI fails a lowering
 * that was not committed, and `.github/scripts/baseline-growth.cjs` refuses a pull request that raises one.
 * To start over, delete the baseline and run `FILE_LENGTH_UPDATE=1 npm run lint`. It pins what is over the
 * limit then. `node packages/cezar/src/lint/file-length.ts headroom <paths>` prints the lines a file has left.
 *
 * Counted: every tracked `*.ts`, `*.tsx`, `*.mjs` and `*.cjs` under `packages/`, except tests,
 * test kits, browser specs, `test/` directories and fixtures. Length is the newline count, as `wc -l`.
 */
const repo = join(import.meta.dirname, '../../../..');
const baselinePath = join(import.meta.dirname, '../file-length.baseline.json');

const baselineName = 'packages/cezar/src/file-length.baseline.json';
const MAKE_ROOM = 'Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit';

const COUNTED = /\.(ts|tsx|mjs|cjs)$/;
const EXCLUDED = /\.(test|testkit|e2e)\.|\/test\/|__fixtures__|\/fixtures\//;
export const isCounted = (path: string): boolean => COUNTED.test(path) && !EXCLUDED.test(path);
export const lineCount = (text: string): number => text.split('\n').length - 1;
const lengthOf = (lengths: Record<string, number>, path: string): number => lengths[path] ?? 0;

export interface Baseline {
  $comment: string;
  limit: number;
  files: Record<string, number>;
}

function sourceLengths(): Record<string, number> {
  const listed = gitSync(['ls-files', '-z', '--', 'packages'], { cwd: repo, maxBuffer: 16 << 20 });
  return Object.fromEntries(
    listed
      .split('\0')
      .filter((path) => path && isCounted(path))
      .map((path) => [path, lineCount(readFileSync(join(repo, path), 'utf8'))]),
  );
}

const readBaseline = (file = baselinePath): Baseline => JSON.parse(readFileSync(file, 'utf8')) as Baseline;

/**
 * `unpinned`: a file over the limit that the baseline lacks. `grown`: a pinned file longer than its pin.
 * `stale`: a pin above the file's length, or for a file that is gone or at the limit or under it. The
 * baseline must shrink to match, or the ratchet would let the file grow back.
 */
export function compareLengths(lengths: Record<string, number>, baseline: Baseline) {
  const over = Object.entries(lengths).filter(([, lines]) => lines > baseline.limit);
  return {
    unpinned: over.filter(([path]) => !(path in baseline.files)).map(([path, lines]) => `${path}: ${lines} lines, over the limit of ${baseline.limit}`),
    grown: over.filter(([path, lines]) => lines > (baseline.files[path] ?? Infinity)).map(([path, lines]) => `${path}: ${lines} lines, pinned at ${baseline.files[path]}`),
    stale: Object.entries(baseline.files)
      .filter(([path, pin]) => lengthOf(lengths, path) < pin || lengthOf(lengths, path) <= baseline.limit)
      .map(([path, pin]) => `${path}: pinned at ${pin}, now ${lengths[path] ?? 'gone'}`),
  };
}

/** Lower every pin to the file's length and drop the pins that no longer apply. Never adds or raises one. */
export function pinnedLengths(lengths: Record<string, number>, baseline: Baseline): Record<string, number> {
  const files = Object.entries(baseline.files)
    .filter(([path]) => lengthOf(lengths, path) > baseline.limit)
    .map(([path, pin]) => [path, Math.min(pin, lengths[path] ?? pin)] as const);
  return Object.fromEntries(files.sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline(file: string, limit: number, files: Record<string, number>): void {
  const baseline: Baseline = {
    $comment:
      'Non-test source files over 1,000 lines, pinned at their length when the ratchet landed (hearsay-tools/cezarion#1800). ' +
      'A pin only shrinks: npm run lint lowers it when a file got smaller; commit this file then. ' +
      'A new file over the limit is a failure, not an entry. Rules: docs/sdlc/ci.md.',
    limit,
    files,
  };
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** Lower the pins, or pin everything over the limit when there is no baseline yet. */
function updateBaseline(file: string, lengths: Record<string, number>, limit = 1000): void {
  if (existsSync(file)) {
    const baseline = readBaseline(file);
    writeBaseline(file, baseline.limit, pinnedLengths(lengths, baseline));
    return;
  }
  const over = Object.entries(lengths).filter(([, lines]) => lines > limit);
  writeBaseline(file, limit, Object.fromEntries(over.sort(([a], [b]) => a.localeCompare(b))));
}

/** Lower the pins of files that got smaller, and say which. */
function lowerPins(file: string, lengths: Record<string, number>, notify: (line: string) => void): void {
  const baseline = readBaseline(file);
  const { stale } = compareLengths(lengths, baseline);
  if (stale.length === 0) return;
  writeBaseline(file, baseline.limit, pinnedLengths(lengths, baseline));
  notify(`${baselineName}: ${stale.join('; ')}. Commit the baseline`);
}

/** The length budget for `lengths` against the baseline at `file`, after `mode` updated it. */
export function lengthProblems(lengths: Record<string, number>, mode: BaselineMode, notify: (line: string) => void, file = baselinePath): string[] {
  if (mode === 'write') updateBaseline(file, lengths);
  if (!existsSync(file)) {
    return [`${baselineName}:1 file-length: Write the first baseline: FILE_LENGTH_UPDATE=1 npm run lint`];
  }
  if (mode === 'lower') lowerPins(file, lengths, notify);
  const { unpinned, grown, stale } = compareLengths(lengths, readBaseline(file));
  const report = (entry: string, fix: string): string => {
    const at = entry.indexOf(':');
    return `${entry.slice(0, at)}:1 file-length: ${entry.slice(at + 2)}. ${fix}`;
  };
  return [
    ...unpinned.map((entry) => report(entry, `${MAKE_ROOM}. Do not add the file to the baseline`)),
    ...grown.map((entry) => report(entry, `${MAKE_ROOM}. Then npm run lint lowers the pin`)),
    ...stale.map((entry) => report(entry, `The file got smaller: run npm run lint locally, which lowers the pin, and commit ${baselineName}`)),
  ];
}

/** The repository length budget. A local run lowers the pins of files that got smaller and says so. */
export function fileLengthProblems(mode: BaselineMode = baselineMode(process.env.FILE_LENGTH_UPDATE === '1'), notify = printLowered): string[] {
  return lengthProblems(sourceLengths(), mode, notify);
}

/**
 * One line per path: its length, its pin or the limit, and the lines left. A path under a test path is
 * measured as production, because it counts once it leaves that path; a path that does not exist yet has 0 lines.
 */
export function headroomLines(paths: string[], lengthOf: (path: string) => number | undefined, baseline: Baseline): string[] {
  return paths.map((path) => {
    const lines = lengthOf(path);
    const pin = baseline.files[path];
    const left = (pin ?? baseline.limit) - (lines ?? 0);
    const budget = pin === undefined ? `limit ${baseline.limit}` : `pinned at ${pin}`;
    const room = left >= 0 ? `${left} lines left` : `${-left} lines over`;
    const note = !path.startsWith('packages/') || !COUNTED.test(path) ? '; not counted: only .ts, .tsx, .mjs and .cjs files under packages/ count'
      : EXCLUDED.test(path) ? '; a test path, not counted now, measured as production for a move out of it'
        : lines === undefined ? '; no such file yet' : '';
    return `${path}: ${lines ?? 0} lines, ${budget}, ${room}${note}`;
  });
}

function readLength(path: string): number | undefined {
  const file = join(repo, path);
  return existsSync(file) ? lineCount(readFileSync(file, 'utf8')) : undefined;
}

if (import.meta.main) {
  const [command, ...paths] = process.argv.slice(2);
  if (command !== 'headroom' || paths.length === 0) {
    console.error('Usage: node packages/cezar/src/lint/file-length.ts headroom <path>...');
    process.exitCode = 2;
  } else {
    const relativePaths = paths.map((path) => relative(repo, resolve(path)));
    for (const line of headroomLines(relativePaths, readLength, readBaseline())) console.log(line);
  }
}
