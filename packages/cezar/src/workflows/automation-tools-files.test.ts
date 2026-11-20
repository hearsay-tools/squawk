import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('has automation tool native transport coverage for every runner', () => {
  const runners = fileURLToPath(new URL('../runners/', import.meta.url));
  const files = readdirSync(runners, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(({ name }) => readdirSync(`${runners}${name}`).filter(file => /^automation-tools-[a-z]+-parity\.test\.ts$/.test(file)).map(file => `${name}/${file}`));
  expect(files.sort()).toEqual(BUILT_IN_RUNNER_IDS.map(runner => `${runner}/automation-tools-${runner}-parity.test.ts`).sort());
});
