import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRule } from './ast-rule.testkit.ts';
import {
  BARE_REAL_CLOCK_MESSAGE, CLOCK_DATE_MESSAGE, clockDateRule, clockDatesFile, staleClockDates, testUnpinnedClockDate,
} from './test-unpinned-clock-date.ts';

const file = 'packages/cezar/src/automations/clock-fixture.test.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const findings = (source: string, at = file) => checkRule(testUnpinnedClockDate, at, source);

describe('test-unpinned-clock-date (hearsay-tools/squawk#4194)', () => {
  it.each([
    // hearsay-tools/squawk#2537: a fixed fixture date that a 7-day lookback in the code under test drops.
    ['the 7-day lookback fixture', "const epoch = Date.parse('2026-10-27T00:00:00Z');\nconst at = (s: number) => new Date(epoch + s * 1000).toISOString();"],
    // git-sidebar.e2e.ts: a date relative to the real clock beside a "today" count.
    ['a Date.now()-relative fixture date', 'const ago = (ms: number) => new Date(Date.now() - ms).toISOString();'],
    ['a date-only literal', "expect(day).toBe('2026-11-03');"],
    ['a template that starts with a date', 'const at = `2026-11-03T${hour}:00:00Z`;'],
    ['a template part after a substitution', 'const at = `${day}2026-11-03`;'],
    ['a later date sum', 'const soon = new Date(Date.now() + 2 * DAY);'],
    ['a wrapped date sum', 'const soon = new Date((Date.now() - 1000) as number);'],
  ])('refuses %s', (_case, source) => {
    expect(findings(`\n${source}`)).toEqual([{ line: 2, message: CLOCK_DATE_MESSAGE }]);
  });

  it('reports every site in a file', () => {
    expect(findings("const a = '2026-01-01';\nconst b = new Date(Date.now() - 1);")).toEqual([
      { line: 1, message: CLOCK_DATE_MESSAGE }, { line: 2, message: CLOCK_DATE_MESSAGE },
    ]);
  });

  it.each([
    ['a pinned clock', "vi.setSystemTime(Date.parse('2026-10-27T00:00:00Z'));"],
    ['fake timers', "beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));\nconst at = new Date(Date.now() - 1000);"],
    ['a reasoned real clock', '// real-clock: the browser runs at local noon\nconst at = new Date(Date.now() - 1000);'],
    ['a deadline', 'const deadline = Date.now() + 5000;'],
    ['a duration', 'const spent = Date.now() - started;'],
    ['the current time', 'const now = new Date(Date.now());'],
    ['a date in the middle of a string', "const text = 'fetched on 2026-11-03';"],
    ['a version, not a date', "const version = '2026-13-01';"],
    ['a date in a comment', '// 2026-11-03 is when it broke'],
  ])('passes %s', (_case, source) => {
    expect(findings(source)).toEqual([]);
  });

  it('reports a real-clock comment that gives no reason, and it excuses nothing', () => {
    expect(findings("// real-clock:\nconst at = '2026-01-01';")).toEqual([
      { line: 1, message: BARE_REAL_CLOCK_MESSAGE }, { line: 2, message: CLOCK_DATE_MESSAGE },
    ]);
  });

  it.each([
    ['packages/web/e2e/git-sidebar.e2e.ts', true],
    ['packages/web/src/routes/repo-git/git-sections.test.ts', true],
    ['packages/cezar/src/server/repo.test.tsx', true],
    ['packages/cezar/src/automations/scheduler.ts', false],
    ['packages/cezar/src/run-store.testkit.ts', false],
    ['packages/cezar/src/lint/test-unpinned-clock-date.test.ts', false],
    ['scripts/check.test.mjs', false],
  ])('reads %s: %s', (path, applies) => {
    expect(testUnpinnedClockDate.applies(path)).toBe(applies);
  });

  it('allows the baselined count of sites, then reports the rest and a count that is too high', () => {
    const rule = clockDateRule({ [file]: 1 });
    expect(checkRule(rule, file, "const a = '2026-01-01';")).toEqual([]);
    expect(checkRule(rule, file, "const a = '2026-01-01';\nconst b = '2026-01-02';")).toEqual([{ line: 2, message: CLOCK_DATE_MESSAGE }]);
    expect(checkRule(rule, file, 'const a = 1;')).toEqual([
      { line: 1, message: `${clockDatesFile} lists 1 unpinned clock dates for this file, but it has 0. Lower the count, or remove the entry at 0.` },
    ]);
  });

  it('names baseline entries whose file is gone or out of scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'clock-dates-'));
    roots.push(root);
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    write('packages/web/src/kept.test.ts', "const a = '2026-01-01';\n");
    write('packages/web/src/plain.ts', "const a = '2026-01-01';\n");
    write(clockDatesFile, JSON.stringify({ files: { 'packages/web/src/kept.test.ts': 1, 'packages/web/src/gone.test.ts': 1, 'packages/web/src/plain.ts': 1 } }));
    expect(staleClockDates(root)).toEqual([
      `${clockDatesFile} cez/test-unpinned-clock-date: stale or invalid entry packages/web/src/gone.test.ts (1); remove it`,
      `${clockDatesFile} cez/test-unpinned-clock-date: stale or invalid entry packages/web/src/plain.ts (1); remove it`,
    ]);
    expect(staleClockDates()).toEqual([]);
  });
});
