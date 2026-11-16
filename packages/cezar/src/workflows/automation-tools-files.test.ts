import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';

it('has automation tool native transport coverage for every runner', () => {
  const files = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter(file => /^automation-tools-[a-z]+-parity\.test\.ts$/.test(file));
  expect(files.sort()).toEqual(RUNNER_IDS.map(runner => `automation-tools-${runner}-parity.test.ts`).sort());
});
