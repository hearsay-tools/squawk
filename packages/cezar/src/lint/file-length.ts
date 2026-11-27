import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gitSync } from '../git-command.ts';
import { baselineMode, printLowered, type BaselineMode } from './baseline-mode.ts';

/**
 * Source files over 1,000 lines are pinned at their current length (hearsay-tools/cezarion#1800).
 *
 * A pinned file may not grow, and no other file may pass the limit. Each pin is its own file,
 * `packages/cezar/src/file-length.baseline/<source path>.json` holding `{ "lines": <n> }`, so two pull requests that
 * change different files never edit adjacent lines and merge in GitHub's merge queue (hearsay-tools/squawk#4362).
 * The pins only shrink: a local `npm run lint` lowers the pin of a file that got smaller and deletes the pin of a
 * file at or under the limit (`lint/baseline-mode.ts`), CI fails a lowering that was not committed, and
 * `.github/scripts/baseline-growth.cjs` refuses a pull request that raises or adds a pin. With no pins at all,
 * `FILE_LENGTH_UPDATE=1 npm run lint` pins what is over the limit. `node packages/cezar/src/lint/file-length.ts
 * headroom <paths>` prints the lines a file has left.
 *
 * Counted: every tracked `*.ts`, `*.tsx`, `*.mjs` and `*.cjs` under `packages/`, except tests,
 * test kits, browser specs, `test/` directories and fixtures. Length is the newline count, as `wc -l`.
 */
const repo = join(import.meta.dirname, '../../../..');
export const PINS = 'packages/cezar/src/file-length.baseline';
export const LIMIT = 1000;
const MAKE_ROOM = 'Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit';

const COUNTED = /\.(ts|tsx|mjs|cjs)$/;
const EXCLUDED = /\.(test|testkit|e2e)\.|\/test\/|__fixtures__|\/fixtures\//;
export const isCounted = (path: string): boolean => COUNTED.test(path) && !EXCLUDED.test(path);
export const lineCount = (text: string): number => text.split('\n').length - 1;
const lengthOf = (lengths: Record<string, number>, path: string): number => lengths[path] ?? 0;

/** Each pinned source path with its pin. */
export type Pins = Record<string, number>;

function sourceLengths(): Record<string, number> {
  const listed = gitSync(['ls-files', '-z', '--', 'packages'], { cwd: repo, maxBuffer: 16 << 20 });
  return Object.fromEntries(
    listed
      .split('\0')
      .filter((path) => path && isCounted(path))
      .map((path) => [path, lineCount(readFileSync(join(repo, path), 'utf8'))]),
  );
}

/** The pin in one pin file, or undefined when the file is not `{ "lines": <whole number> }`. */
function pinIn(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Object.keys(value).join() !== 'lines') return undefined;
    const { lines } = value as { lines: unknown };
    return Number.isSafeInteger(lines) ? (lines as number) : undefined;
  } catch {
    return undefined;
  }
}

/** The pins under `dir`, and a problem for each file there that is not a valid pin. A missing directory has no pins. */
export function readPins(dir: string): { pins: Pins; invalid: string[] } {
  const pins: Pins = {};
  const invalid: string[] = [];
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()) : [];
  for (const entry of files) {
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    const pin = path.endsWith('.json') ? pinIn(readFileSync(join(dir, path), 'utf8')) : undefined;
    if (pin === undefined) invalid.push(`${PINS}/${path}:1 file-length: A pin file is <source path>.json holding { "lines": <whole number> }`);
    else pins[path.slice(0, -'.json'.length)] = pin;
  }
  return { pins, invalid: invalid.sort() };
}

/**
 * `unpinned`: a file over the limit that has no pin. `grown`: a pinned file longer than its pin.
 * `stale`: a pin above the file's length, or for a file that is gone or at the limit or under it. The
 * pins must shrink to match, or the ratchet would let the file grow back.
 */
export function compareLengths(lengths: Record<string, number>, pins: Pins) {
  const over = Object.entries(lengths).filter(([, lines]) => lines > LIMIT);
  return {
    unpinned: over.filter(([path]) => !(path in pins)).map(([path, lines]) => `${path}: ${lines} lines, over the limit of ${LIMIT}`),
    grown: over.filter(([path, lines]) => lines > (pins[path] ?? Infinity)).map(([path, lines]) => `${path}: ${lines} lines, pinned at ${pins[path]}`),
    stale: Object.entries(pins)
      .filter(([path, pin]) => lengthOf(lengths, path) < pin || lengthOf(lengths, path) <= LIMIT)
      .map(([path, pin]) => `${path}: pinned at ${pin}, now ${lengths[path] ?? 'gone'}`),
  };
}

/** Lower every pin to the file's length and drop the pins that no longer apply. Never adds or raises one. */
export function pinnedLengths(lengths: Record<string, number>, pins: Pins): Pins {
  return Object.fromEntries(Object.entries(pins)
    .filter(([path]) => lengthOf(lengths, path) > LIMIT)
    .map(([path, pin]) => [path, Math.min(pin, lengths[path] ?? pin)]));
}

const pinFile = (dir: string, path: string): string => join(dir, `${path}.json`);

/** Write `next` over `previous`: rewrite each changed pin file and delete each dropped one with its empty folders. */
function writePins(dir: string, previous: Pins, next: Pins): void {
  for (const path of Object.keys(previous).filter((path) => !(path in next))) {
    rmSync(pinFile(dir, path));
    for (let folder = dirname(pinFile(dir, path)); folder.startsWith(`${dir}${sep}`) && readdirSync(folder).length === 0; folder = dirname(folder)) rmdirSync(folder);
  }
  for (const [path, lines] of Object.entries(next).filter(([path, lines]) => previous[path] !== lines)) {
    mkdirSync(dirname(pinFile(dir, path)), { recursive: true });
    writeFileSync(pinFile(dir, path), `${JSON.stringify({ lines })}\n`);
  }
}

/** The length budget for `lengths` against the pins in `dir`, after `mode` updated them. */
export function lengthProblems(lengths: Record<string, number>, mode: BaselineMode, notify: (line: string) => void, dir = join(repo, PINS)): string[] {
  const { pins, invalid } = readPins(dir);
  if (invalid.length > 0) return invalid;
  const fresh = mode === 'write' && Object.keys(pins).length === 0;
  const next = fresh ? Object.fromEntries(Object.entries(lengths).filter(([, lines]) => lines > LIMIT)) : pinnedLengths(lengths, pins);
  const { stale } = compareLengths(lengths, pins);
  if (mode !== 'report' && (fresh || stale.length > 0)) writePins(dir, pins, next);
  if (mode === 'lower' && stale.length > 0) notify(`${PINS}: ${stale.join('; ')}. Commit the pin files`);
  const { unpinned, grown, stale: left } = compareLengths(lengths, mode === 'report' ? pins : next);
  const report = (entry: string, fix: string): string => {
    const at = entry.indexOf(':');
    return `${entry.slice(0, at)}:1 file-length: ${entry.slice(at + 2)}. ${fix}`;
  };
  return [
    ...unpinned.map((entry) => report(entry, `${MAKE_ROOM}. Do not add a pin for the file`)),
    ...grown.map((entry) => report(entry, `${MAKE_ROOM}. Then npm run lint lowers the pin`)),
    ...left.map((entry) => report(entry, `The file got smaller: run npm run lint locally, which lowers or deletes the pin, and commit ${PINS}/`)),
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
export function headroomLines(paths: string[], lengthOf: (path: string) => number | undefined, pins: Pins): string[] {
  return paths.map((path) => {
    const lines = lengthOf(path);
    const pin = pins[path];
    const left = (pin ?? LIMIT) - (lines ?? 0);
    const budget = pin === undefined ? `limit ${LIMIT}` : `pinned at ${pin}`;
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
    for (const line of headroomLines(relativePaths, readLength, readPins(join(repo, PINS)).pins)) console.log(line);
  }
}
