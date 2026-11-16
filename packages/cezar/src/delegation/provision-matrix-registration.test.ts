import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVISION_ROWS, PROVISION_TEST_FILES, provisionMatrixCounts } from './provision-workflows.testkit.ts';

// Static checks of the provision matrix registrations: no fixture, no run manager.
describe('provision matrix registration', () => {
  it('registers every provision matrix exactly once', () => {
    const sources = PROVISION_TEST_FILES.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
    expect(provisionMatrixCounts(sources)).toEqual(Object.fromEntries(Object.keys(PROVISION_ROWS).map(name => [name, 1])));
  });

  for (const argument of [
    '[...PROVISION_ROWS.governedIntent]',
    'rows',
    'PROVISION_ROWS["governedIntent"]',
    '',
    '...PROVISION_ROWS.governedIntent',
    'PROVISION_ROWS.unknown',
    'PROVISION_ROWS.governedIntent, extra',
  ]) it(`rejects unresolved provision registration argument ${argument}`, () => {
    const call = `it.each(${argument})`;
    expect(() => provisionMatrixCounts([`${call};`], ['third-provision.test.ts'])).toThrow(`third-provision.test.ts: unsupported it.each registration: ${call}`);
  });
  it('checks nested provision registrations and ignores non-code text', () => {
    const call = 'it.each(PROVISION_ROWS.governedIntent)';
    expect(() => provisionMatrixCounts([`function later() { ${call}; }`])).toThrow();
    expect(() => provisionMatrixCounts(['function later() { it.each(rows); }'], ['nested.test.ts'])).toThrow('nested.test.ts: unsupported');
    expect(provisionMatrixCounts([`// ${call}\n/* ${call} */\nconst text = "${call}"; const template = \`${call}\`;`]).governedIntent).toBe(0);
    const declaration = `${call}('row', () => {});`;
    expect(provisionMatrixCounts([`${declaration} ${declaration}`]).governedIntent).toBe(2);
    expect(provisionMatrixCounts([`describe('suite', () => { ${declaration} });`]).governedIntent).toBe(1);
  });

  for (const source of [
    "it.each(PROVISION_ROWS.governedIntent);",
    "it.each(PROVISION_ROWS.governedIntent)('row');",
    "it.each(PROVISION_ROWS.governedIntent)('row', callback);",
    "function later() { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); }",
    "if (false) { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); }",
    "it('later', () => { it.each(PROVISION_ROWS.governedIntent)('row', () => {}); });",
  ]) it(`rejects provision calls that do not declare tests ${source}`, () => {
    expect(() => provisionMatrixCounts([source], ['unexecuted.test.ts'])).toThrow('unexecuted.test.ts: unsupported');
  });

  for (const source of [
    'it.each?.(PROVISION_ROWS.governedIntent)',
    'const r = it.each',
    'it.each.call(null, PROVISION_ROWS.governedIntent)',
    'consume(it.each)',
    'it.each.apply(null, [PROVISION_ROWS.governedIntent])',
    'it.each.bind(null)',
    'it["each"](PROVISION_ROWS.governedIntent)',
  ]) it(`rejects unaccounted provision registration reference ${source}`, () => {
    expect(() => provisionMatrixCounts([`${source};`], ['reference.test.ts'])).toThrow('reference.test.ts: unsupported');
  });

  for (const source of [
    'it?.["each"](PROVISION_ROWS.governedIntent)',
    'it["each"](PROVISION_ROWS.governedIntent)',
    'it[`each`](PROVISION_ROWS.governedIntent)',
    'const key = "each"',
    'const key = `each`',
  ]) it(`rejects exact provision registration-name literals ${source}`, () => {
    expect(() => provisionMatrixCounts([`${source};`], ['literal.test.ts'])).toThrow('literal.test.ts: unsupported');
  });
  it('ignores comments and longer literals containing the provision registration name', () => {
    expect(provisionMatrixCounts(['// each\n/* each */\nconst text = "prefix each suffix"; const template = `prefix each suffix`;']).governedIntent).toBe(0);
  });

});
