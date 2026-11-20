import { readFileSync, readdirSync } from 'node:fs';
import { expect } from 'vitest';

/** Check the row partition and the thin files that register it independently. `families` names each
 *  family's runners, as its class in `core/parity-classes.testkit.ts` gives them. */
export function expectWaitRowCoverage(groups: Record<string, readonly string[]>, families: Readonly<Record<string, readonly string[]>>, prefix: string, helper: string) {
  const expected = Object.entries(families).flatMap(([family, runners]) => runners.map(runner => `${runner}:${family}`));
  expect(Object.entries(groups).flatMap(([family, runners]) => runners.map(runner => `${runner}:${family}`)).sort()).toEqual(expected.sort());
  const calls = readdirSync(new URL('.', import.meta.url)).filter(file => file.startsWith(prefix) && file.endsWith('-parity.test.ts'))
    .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .filter(source => source.includes(`from './${helper}'`))
    .flatMap(source => [...source.matchAll(/registerGroup\('([^']+)'\)/g)].map(match => match[1]));
  expect(calls.sort()).toEqual(Object.keys(groups).sort());
}
