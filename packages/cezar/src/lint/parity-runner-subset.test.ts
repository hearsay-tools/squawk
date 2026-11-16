import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { parityRunnerSubset, runnerSubsets } from './parity-runner-subset.ts';

const file = 'packages/cezar/src/core/runner-group-parity.test.ts';
const quoted = (ids: readonly string[]) => ids.map(id => `'${id}'`).join(', ');
const [first, second] = RUNNER_IDS;
const PAIR = quoted([first, second]);

describe('parity-runner-subset (hearsay-tools/squawk#3642)', () => {
  it.each([
    ['a pair', `const held = [${PAIR}];`],
    ['a const tuple in a loop', `for (const backend of [${PAIR}] as const) {}`],
    ['a set', `const held = new Set([${PAIR}]);`],
    ['an includes test', `if ([${PAIR}].includes(runner)) {}`],
    ['an oracle', `expect([${PAIR}]).toContain(runner);`],
    ['every runner but one', `const rest = [${quoted(RUNNER_IDS.slice(1))}];`],
    ['cast and template elements', `const held = [\`${first}\`, '${second}' as const];`],
    ['one id per line', `const held = [\n  '${first}',\n  '${second}',\n];`],
  ])('refuses %s', (_case, source) => {
    expect(runnerSubsets(file, `\n${source}`)).toHaveLength(1);
    expect(parityRunnerSubset.check(file, `\n${source}`)).toEqual([
      { line: 2, message: expect.stringMatching(/runnersWhere\(\).+exemptWhere\(\).+hearsay-tools\/squawk#3642/) },
    ]);
  });

  it.each([
    ['a one-runner shard', `subagentCells(['${first}']);`],
    ['one runner twice', `const one = ['${first}', '${first}'];`],
    ['a per-runner reason table', `const reasons = [['${first}', 'its wire'], ['${second}', 'its wire']];`],
    ['a pair beside another value', `const mixed = [${PAIR}, 'gh'];`],
    ['every runner', `const all = [${quoted(RUNNER_IDS)}];`],
    ['a list derived from the facts', "const held = runnersWhere(facts => facts.hookEvents === 'none');"],
    ['object keys', `const reasons = { ${first}: 'a', ${second}: 'b' };`],
    ['a union type', `type Pair = '${first}' | '${second}';`],
    ['a string', `const text = "[${PAIR}]";`],
    ['a comment', `// [${PAIR}]`],
    ['separate arguments', `pick(${PAIR});`],
    ['an empty array', 'const none = [];'],
  ])('passes %s', (_case, source) => {
    expect(runnerSubsets(file, source)).toEqual([]);
  });

  it('reads JSX and plain JavaScript and refuses malformed source that quotes two ids', () => {
    expect(runnerSubsets('packages/web/src/routes/runner-parity.tsx', `const tabs = <Tabs ids={[${PAIR}]} />;`)).toHaveLength(1);
    expect(runnerSubsets('packages/cezar/scripts/parity-rows.mjs', `export const held = [${PAIR}];`)).toHaveLength(1);
    expect(() => runnerSubsets(file, `const a = [${PAIR}]; let x = ;`)).toThrow();
    expect(runnerSubsets(file, 'let x = ;')).toEqual([]);
  });

  it.each([
    ['packages/cezar/src/core/harness-parity-core.testkit.ts', true],
    ['packages/cezar/src/core/ui-parity.test.ts', true],
    ['packages/cezar/src/workflows/waits-parity-entries-cells.testkit.ts', true],
    ['packages/cezar/scripts/parity-rows.ts', true],
    ['packages/cezar/src/core/owned-input-delivery.test.ts', false],
    ['packages/cezar/src/parity/runner-group.ts', false],
    ['scripts/parity.mjs', false],
    ['packages/cezar/src/core/ui-parity.md', false],
  ])('scopes %s', (path, expected) => {
    expect(parityRunnerSubset.applies(path)).toBe(expected);
  });
});
