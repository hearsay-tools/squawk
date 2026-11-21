import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';

it.each(BUILT_IN_RUNNER_IDS)('%s owns its UI mapper robustness wrapper', runner => {
  const wrapper = join(import.meta.dirname, '..', 'runners', runner, 'ui-mapper-robustness.test.ts');
  // A missing file fails with its full path. The call pins registration to this runner.
  const source = readFileSync(wrapper, 'utf8');
  expect(source).toContain(`describeUiMapperRobustness('${runner}')`);
});
