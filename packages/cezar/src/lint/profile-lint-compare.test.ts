import { expect, it } from 'vitest';
import { type CompareRound, compareReport, lintedFiles, median, rootRelativePaths, ruleTimings } from '../../scripts/profile-lint-compare.ts';

// The `profile-lint.ts --compare` report (hearsay-tools/squawk#4238).

const round = (load: number, base: number, candidate: number, baseMs: number, candidateMs: number): CompareRound => ({
  loads: [load, load],
  base: { user: base, sys: 0.5 },
  candidate: { user: candidate, sys: 0.6 },
  baseTimings: { 'cez/a': baseMs, 'cez/b': 100 },
  candidateTimings: { 'cez/a': candidateMs, 'cez/b': 100, 'cez/new': 40 },
});

it('takes the middle value, or the mean of the two middle values', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

it('reads the cez rows of oxlint --debug timings and skips the header and other sources', () => {
  const output = [
    'Rule                       Time (ms)  Relative    Calls  Source',
    '-------------------------  ---------  --------  -------  ---------',
    'cez/test-wait-discipline    1748.608     27.9%   404383  js-plugin',
    'eslint/no-debugger             3.100      0.1%      812  builtin',
    'cez/probe-release-port       756.527     12.1%   550942  js-plugin',
  ].join('\n');
  expect(ruleTimings(output)).toEqual({ 'cez/test-wait-discipline': 1748.608, 'cez/probe-release-port': 756.527 });
});

it('prints medians, ranges, ratios, host load and per-rule deltas', () => {
  const report = compareReport({
    base: 'commit origin/main (abc123456)',
    command: 'oxlint -c <config> packages',
    rounds: [round(2, 15, 16, 500, 520), round(3, 14, 15.5, 480, 530), round(1, 16, 17, 510, 525)],
    cores: 16,
  });
  expect(report).toBe([
    'Base: commit origin/main (abc123456). Candidate: the working tree. Command: oxlint -c <config> packages; 3 alternating rounds; CPU in seconds, JS time in ms.',
    '',
    '| Side | User median | User range | Sys median | `cez/*` JS ms median |',
    '| --- | ---: | ---: | ---: | ---: |',
    '| base | 15.00 | 14.00–16.00 | 0.50 | 600 |',
    '| candidate | 16.00 | 15.50–17.00 | 0.60 | 665 |',
    '',
    'Candidate/base: user CPU 1.07, `cez/*` JS time 1.11.',
    'Host: 16 cores; median 1-minute load 2.00; user-CPU ceiling 8.00 (half the cores).',
    '',
    '| Rule | Base ms | Candidate ms | Delta |',
    '| --- | ---: | ---: | ---: |',
    '| cez/a | 500 | 525 | +25 |',
    '| cez/b | 100 | 100 | +0 |',
    '| cez/new | 0 | 40 | +40 |',
  ].join('\n'));
});

it.each([
  [7.99, false],
  [8, true],
  [30, true],
])('with median load %d on 16 cores, warns that user CPU is not evidence: %s', (load, warns) => {
  const report = compareReport({ base: 'config base.json', command: 'oxlint', rounds: [round(load, 15, 16, 500, 520)], cores: 16 });
  expect(report.includes('Load above ceiling: user CPU is not evidence; report the `--debug timings` sums.')).toBe(warns);
});

// A side that lints no files measures nothing; a side with no `cez/*` rule is a valid base.
it('reads the linted file count from the Finished line', () => {
  expect(lintedFiles('Found 0 warnings and 0 errors.\nFinished in 773ms on 128 files with 155 rules using 16 threads.')).toBe(128);
  expect(lintedFiles('No files found to lint.\nFinished in 255ms on 0 files with 155 rules using 16 threads.')).toBe(0);
  expect(lintedFiles('Finished in 10ms on 1 file with 3 rules using 1 thread.')).toBe(1);
  expect(lintedFiles('cez/a 1.0 1% 3 js-plugin')).toBeUndefined();
});

// An absolute path would make the extracted base tree lint the working tree's files.
it('makes lint paths relative to the repository root and refuses paths outside it', () => {
  expect(rootRelativePaths(['packages/web', '/repo/packages/cezar', '/repo'], '/repo')).toEqual(['packages/web', 'packages/cezar', '.']);
  expect(() => rootRelativePaths(['/other/packages'], '/repo')).toThrow('/other/packages is outside /repo');
  expect(() => rootRelativePaths(['/repository'], '/repo')).toThrow('outside');
});
