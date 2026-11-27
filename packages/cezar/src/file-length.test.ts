import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineMode } from './lint/baseline-mode.ts';
import { compareLengths, headroomLines, isCounted, lengthProblems, lineCount, pinnedLengths, PINS, readPins, type Pins } from './lint/file-length.ts';

describe('the length rules', () => {
  const baseline: Pins = { 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100 };
  const compare = (lengths: Record<string, number>) => compareLengths(lengths, baseline);

  it('passes pinned files at their pin and every file at the limit', () => {
    const lengths = { 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100, 'packages/a/edge.ts': 1000 };
    expect(compare(lengths)).toEqual({ unpinned: [], grown: [], stale: [] });
  });

  it('fails a pinned file that grew, and a file that passed the limit', () => {
    const lengths = { 'packages/a/long.ts': 1501, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100, 'packages/a/new.ts': 1001 };
    const result = compare(lengths);
    expect(result.grown).toEqual(['packages/a/long.ts: 1501 lines, pinned at 1500']);
    expect(result.unpinned).toEqual(['packages/a/new.ts: 1001 lines, over the limit of 1000']);
    expect(result.stale).toEqual([]);
  });

  it('calls a pin stale once its file shrank, fell to the limit, or went away', () => {
    const lengths = { 'packages/a/long.ts': 1400, 'packages/a/shrunk.ts': 1000 };
    expect(compare(lengths).stale).toEqual([
      'packages/a/long.ts: pinned at 1500, now 1400',
      'packages/a/gone.ts: pinned at 1200, now gone',
      'packages/a/shrunk.ts: pinned at 1100, now 1000',
    ]);
  });

  it('updates the pins by lowering and dropping pins, never by adding or raising one', () => {
    const lengths = { 'packages/a/long.ts': 1400, 'packages/a/shrunk.ts': 1000, 'packages/a/new.ts': 2000, 'packages/a/gone.ts': 1300 };
    expect(pinnedLengths(lengths, baseline)).toEqual({ 'packages/a/gone.ts': 1200, 'packages/a/long.ts': 1400 });
  });

  it('counts source files and skips tests, test kits, browser specs, test directories and fixtures', () => {
    expect(['a/x.ts', 'a/x.tsx', 'a/x.mjs', 'a/x.cjs', 'packages/web/e2e/agent-browser.ts'].map(isCounted)).toEqual([true, true, true, true, true]);
    const skipped = ['a/x.test.ts', 'a/x.testkit.ts', 'a/x.e2e.ts', 'a/test/x.ts', 'a/__fixtures__/x.ts', 'a/fixtures/x.ts', 'a/x.json', 'a/x.md'];
    expect(skipped.map(isCounted)).toEqual(skipped.map(() => false));
  });

  it('counts newlines as wc -l does', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb\n')]).toEqual([0, 0, 1, 2]);
  });
});

describe('the length gate on a pin directory', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const pinDirectory = (files: Record<string, string | number>): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'file-length-')), 'pins');
    dirs.push(dirname(dir));
    for (const [path, pin] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof pin === 'number' ? JSON.stringify({ lines: pin }) : pin);
    }
    return dir;
  };
  const pins = (dir: string): Pins => readPins(dir).pins;

  it('reads one pin per <source path>.json file and calls a missing directory empty', () => {
    expect(pins(pinDirectory({ 'packages/a/long.ts.json': 1500, 'packages/b/x.tsx.json': 1100 }))).toEqual({ 'packages/a/long.ts': 1500, 'packages/b/x.tsx': 1100 });
    expect(readPins(join(tmpdir(), 'no-such-pins-dir'))).toEqual({ pins: {}, invalid: [] });
  });

  it('fails a pin file that is not { "lines": <whole number> }, and writes nothing', () => {
    const dir = pinDirectory({ 'a.ts.json': '{"lines":"1500"}', 'b.ts.json': '{"lines":1500,"extra":1}', 'c.ts.json': 'not json', 'd.ts': '{"lines":1500}', 'e.ts.json': 1500 });
    const fix = 'file-length: A pin file is <source path>.json holding { "lines": <whole number> }';
    expect(lengthProblems({ 'e.ts': 1400 }, 'lower', () => {}, dir)).toEqual(['a.ts.json', 'b.ts.json', 'c.ts.json', 'd.ts'].map((file) => `${PINS}/${file}:1 ${fix}`));
    expect(pins(dir)).toEqual({ 'e.ts': 1500 });
  });

  it('lowers the pin of a file that got smaller on a local run, deletes a pin that no longer applies, and says so', () => {
    const dir = pinDirectory({ 'packages/a/long.ts.json': 1500, 'packages/b/gone.ts.json': 1200 });
    const lowered: string[] = [];
    expect(lengthProblems({ 'packages/a/long.ts': 1480 }, 'lower', line => lowered.push(line), dir)).toEqual([]);
    expect(pins(dir)).toEqual({ 'packages/a/long.ts': 1480 });
    expect(existsSync(join(dir, 'packages/b'))).toBe(false);
    expect(lowered).toEqual([
      `${PINS}: packages/a/long.ts: pinned at 1500, now 1480; packages/b/gone.ts: pinned at 1200, now gone. Commit the pin files`,
    ]);
  });

  it('writes nothing in CI and fails the pin that was not lowered', () => {
    const dir = pinDirectory({ 'packages/a/long.ts.json': 1500 });
    expect(lengthProblems({ 'packages/a/long.ts': 1480 }, 'report', () => {}, dir)).toEqual([
      `packages/a/long.ts:1 file-length: pinned at 1500, now 1480. The file got smaller: run npm run lint locally, which lowers or deletes the pin, and commit ${PINS}/`,
    ]);
    expect(pins(dir)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('fails a file that grew over its pin with the verbatim move, and never raises or adds a pin', () => {
    const dir = pinDirectory({ 'packages/a/long.ts.json': 1500 });
    const problems = lengthProblems({ 'packages/a/long.ts': 1501, 'packages/a/new.ts': 1001 }, 'lower', () => {}, dir);
    expect(problems).toEqual([
      'packages/a/new.ts:1 file-length: 1001 lines, over the limit of 1000. Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit. Do not add a pin for the file',
      'packages/a/long.ts:1 file-length: 1501 lines, pinned at 1500. Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit. Then npm run lint lowers the pin',
    ]);
    expect(pins(dir)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('pins what is over the limit only with the variable and no pins yet', () => {
    const dir = join(pinDirectory({}), 'missing');
    expect(lengthProblems({ 'packages/a/long.ts': 1500 }, 'lower', () => {}, dir)).toHaveLength(1);
    expect(pins(dir)).toEqual({});
    expect(lengthProblems({ 'packages/a/long.ts': 1500, 'packages/a/short.ts': 900 }, 'write', () => {}, dir)).toEqual([]);
    expect(readFileSync(join(dir, 'packages/a/long.ts.json'), 'utf8')).toBe('{"lines":1500}\n');
    expect(lengthProblems({ 'packages/a/long.ts': 1500, 'packages/a/new.ts': 1100 }, 'write', () => {}, dir)).toHaveLength(1);
    expect(pins(dir)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('keeps the repository pins valid', () => {
    expect(readPins(join(import.meta.dirname, '../../..', PINS)).invalid).toEqual([]);
  });

  it('lowers on a local run, writes with the variable and only reports in CI', () => {
    expect(baselineMode(false, false)).toBe('lower');
    expect(baselineMode(false, true)).toBe('report');
    expect(baselineMode(true, true)).toBe('write');
  });
});

describe('headroom', () => {
  const baseline: Pins = { 'packages/a/long.ts': 1500 };
  const lengths: Record<string, number> = { 'packages/a/long.ts': 1490, 'packages/a/short.ts': 400, 'packages/a/x.testkit.ts': 1200 };
  const headroom = (...paths: string[]) => headroomLines(paths, path => lengths[path], baseline);

  it('prints each file length, its pin or the limit, and the lines left', () => {
    expect(headroom('packages/a/long.ts', 'packages/a/short.ts', 'packages/a/new.ts')).toEqual([
      'packages/a/long.ts: 1490 lines, pinned at 1500, 10 lines left',
      'packages/a/short.ts: 400 lines, limit 1000, 600 lines left',
      'packages/a/new.ts: 0 lines, limit 1000, 1000 lines left; no such file yet',
    ]);
  });

  it('measures a file under a test path as production, for a move out of it', () => {
    expect(headroom('packages/a/x.testkit.ts')).toEqual([
      'packages/a/x.testkit.ts: 1200 lines, limit 1000, 200 lines over; a test path, not counted now, measured as production for a move out of it',
    ]);
  });

  it('names a file the budget does not count', () => {
    expect(headroom('README.md')).toEqual(['README.md: 0 lines, limit 1000, 1000 lines left; not counted: only .ts, .tsx, .mjs and .cjs files under packages/ count']);
  });
});
