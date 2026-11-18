import { describe, expect, it } from 'vitest';
import { workerOutcomeSchema } from '@open-mercato/cezar-contract/worker-outcome';
import { runStatusSchema, stepStateSchema, stepStatusSchema } from '@open-mercato/cezar-contract/runs';
import { timerWaitEntrySchema, waitPhaseSchema, waitSchema, waitViaSchema } from '@open-mercato/cezar-contract/waits';
import { TEST_ENUM_VALUES, testEnumLiteral as rule } from './lint/test-enum-literal.ts';
import { checkRule } from './lint/ast-rule.testkit.ts';

/** Hold each AST enum guard to the contract schemas (hearsay-tools/cezarion#1812). */
/** The object keys the rule reads, each with the values of the contract enum behind it. */
const CONTRACT_VALUES: Record<string, string[]> = {
  status: [...runStatusSchema.options, ...stepStatusSchema.options, ...workerOutcomeSchema.shape.status.options],
  kind: [...waitSchema.options.map((entry) => entry.shape.kind.value), ...stepStateSchema.shape.kind.options],
  phase: [...waitPhaseSchema.options],
  via: [...waitViaSchema.options],
  source: [...timerWaitEntrySchema.shape.source.options],
};


const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('the test-enum-literal rule', () => {
  it('holds each key to its contract values and reports every value in TS and TSX', () => {
    expect(Object.keys(TEST_ENUM_VALUES).sort()).toEqual(Object.keys(CONTRACT_VALUES).sort());
    for (const [key, values] of Object.entries(CONTRACT_VALUES)) {
      expect(unique(TEST_ENUM_VALUES[key]!)).toEqual(unique(values));
      for (const ext of ['ts', 'tsx']) for (const value of unique(values)) {
        expect(checkRule(rule, `packages/web/src/enum.test.${ext}`, `const x = { ${key}: '${value}' }`)).toHaveLength(1);
      }
    }
  });

  it.each([
    ['packages/contract/src/nested/enum.test.ts', true],
    ['packages/api-client/src/enum.test.tsx', true],
    ['packages/cezar/src/enum.testkit.ts', true],
    ['packages/cezar/src/enum.testkit.tsx', false],
    ['packages/web/src/test/wait-fixtures.ts', true],
    ['packages/web/src/test/fixture.tsx', true],
    ['packages/web/src/test/run-summary-fixture.ts', true],
    ['packages/web/e2e/fixtures/make-large-thread.ts', true],
    ['packages/web/e2e/thread.tsx', true],
    ['packages/cezar/test/cli.ts', true],
    ['packages/cezar/test/cli.tsx', false],
    ['packages/cezar/src/enum.ts', false],
    ['packages/web/src/enum.tsx', false],
    ['packages/nested/pkg/src/enum.test.ts', false],
  ])('reads %s: %s', (file, applies) => expect(rule.applies(file)).toBe(applies));
});
