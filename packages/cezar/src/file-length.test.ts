import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineMode } from './lint/baseline-mode.ts';
import { compareLengths, headroomLines, isCounted, lengthProblems, lineCount, pinnedLengths, type Baseline } from './lint/file-length.ts';

describe('the length rules', () => {
  const baseline: Baseline = { $comment: '', limit: 1000, files: { 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100 } };
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

  it('updates a baseline by lowering and dropping pins, never by adding or raising one', () => {
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

describe('the length gate on a baseline file', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const baselineFile = (files: Record<string, number>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'file-length-'));
    dirs.push(dir);
    const file = join(dir, 'file-length.baseline.json');
    writeFileSync(file, JSON.stringify({ $comment: '', limit: 1000, files }));
    return file;
  };
  const pins = (file: string): Record<string, number> => (JSON.parse(readFileSync(file, 'utf8')) as Baseline).files;

  it('lowers the pin of a file that got smaller on a local run, without the variable, and says so', () => {
    const file = baselineFile({ 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200 });
    const lowered: string[] = [];
    expect(lengthProblems({ 'packages/a/long.ts': 1480 }, 'lower', line => lowered.push(line), file)).toEqual([]);
    expect(pins(file)).toEqual({ 'packages/a/long.ts': 1480 });
    expect(lowered).toEqual([
      'packages/cezar/src/file-length.baseline.json: packages/a/long.ts: pinned at 1500, now 1480; packages/a/gone.ts: pinned at 1200, now gone. Commit the baseline',
    ]);
  });

  it('writes nothing in CI and fails the pin that was not lowered', () => {
    const file = baselineFile({ 'packages/a/long.ts': 1500 });
    expect(lengthProblems({ 'packages/a/long.ts': 1480 }, 'report', () => {}, file)).toEqual([
      'packages/a/long.ts:1 file-length: pinned at 1500, now 1480. The file got smaller: run npm run lint locally, which lowers the pin, and commit packages/cezar/src/file-length.baseline.json',
    ]);
    expect(pins(file)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('fails a file that grew over its pin with the verbatim move, and never raises the pin', () => {
    const file = baselineFile({ 'packages/a/long.ts': 1500 });
    const problems = lengthProblems({ 'packages/a/long.ts': 1501, 'packages/a/new.ts': 1001 }, 'lower', () => {}, file);
    expect(problems).toEqual([
      'packages/a/new.ts:1 file-length: 1001 lines, over the limit of 1000. Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit. Do not add the file to the baseline',
      'packages/a/long.ts:1 file-length: 1501 lines, pinned at 1500. Make room by a verbatim move of whole functions to a sibling module; never join lines or squeeze statements to fit. Then npm run lint lowers the pin',
    ]);
    expect(pins(file)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('writes no first baseline on a local run', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'file-length-')), 'missing.json');
    dirs.push(join(file, '..'));
    expect(lengthProblems({ 'packages/a/long.ts': 1500 }, 'lower', () => {}, file)).toEqual([
      'packages/cezar/src/file-length.baseline.json:1 file-length: Write the first baseline: FILE_LENGTH_UPDATE=1 npm run lint',
    ]);
    expect(lengthProblems({ 'packages/a/long.ts': 1500 }, 'write', () => {}, file)).toEqual([]);
    expect(pins(file)).toEqual({ 'packages/a/long.ts': 1500 });
  });

  it('lowers on a local run, writes with the variable and only reports in CI', () => {
    expect(baselineMode(false, false)).toBe('lower');
    expect(baselineMode(false, true)).toBe('report');
    expect(baselineMode(true, true)).toBe('write');
  });
});

describe('headroom', () => {
  const baseline: Baseline = { $comment: '', limit: 1000, files: { 'packages/a/long.ts': 1500 } };
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
