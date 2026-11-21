import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { ROBUSTNESS_PARTS } from './ui-mapper-robustness.testkit.ts';

const wrappers = BUILT_IN_RUNNER_IDS.flatMap(runner => ROBUSTNESS_PARTS.map(part => ({ runner, part })));
it.each(wrappers)('$runner owns its UI mapper robustness wrapper for $part', ({ runner, part }) => {
  const name = part === 'hostile' ? 'ui-mapper-robustness.test.ts' : `ui-mapper-robustness-mutations-${part}.test.ts`;
  const wrapper = join(import.meta.dirname, '..', 'runners', runner, name);
  // A missing file fails with its full path. The call pins this runner and partition.
  const source = readFileSync(wrapper, 'utf8');
  expect(source).toContain(`describeUiMapperRobustness('${runner}', ${JSON.stringify(part)})`);
});
