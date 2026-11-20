import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('has automation tool native transport coverage for every runner', () => {
  const files = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter(file => /^automation-tools-[a-z]+-parity\.test\.ts$/.test(file));
  expect(files.sort()).toEqual(BUILT_IN_RUNNER_IDS.map(runner => `automation-tools-${runner}-parity.test.ts`).sort());
});
