import { expect, it } from 'vitest';
import { formatAutomationTable, measureAutomationLookups, parseAutomationBenchArgs } from '../../scripts/benchmark-automation-lookups.ts';

/** Smoke test for the automation lookup benchmark: its fixture is what the real store opens, and
 *  the list counts every launched run once. */
it('seeds launched runs and counts each of them once across the automations', async () => {
  const row = await measureAutomationLookups({ runs: 41, automations: 2, recordKb: 1, passes: 1 });
  expect(row).toMatchObject({ runs: 41, launched: 3, counted: 3 });
});

it('reads its settings from the command line and refuses ones it cannot use', () => {
  expect(parseAutomationBenchArgs([])).toEqual({ sizes: [1000, 4000, 10000], out: undefined, base: { automations: 12, recordKb: 50, passes: 5 } });
  expect(parseAutomationBenchArgs(['--runs', '5,10', '--passes', '1', '--out', 'r.json'])).toMatchObject({ sizes: [5, 10], out: 'r.json', base: { passes: 1 } });
  for (const args of [['--runs', '0'], ['--runs', '2.5'], ['--automations', '0'], ['--record-kb=-1'], ['--passes', 'Infinity']]) {
    expect(() => parseAutomationBenchArgs(args), args.join(' ')).toThrow('--runs, --automations and --passes take whole numbers');
  }
});

it('prints one table row per size', () => {
  const { base } = parseAutomationBenchArgs([]);
  const table = formatAutomationTable(base, [{ runs: 4000, launched: 200, counted: 200, listMs: 1, receiptMs: 2 }]).split('\n');
  expect(table[0]).toMatch(/^12 automations, record 50 KB, median of 5 calls/);
  expect(table.at(-1)).toBe('| 4000 | 200 | 1 | 2 |');
});
