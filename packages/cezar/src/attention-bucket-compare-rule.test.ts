import { describe, expect, it } from 'vitest';
import { ATTENTION_RANK } from '@open-mercato/cezar-contract/attention';
import { ATTENTION_BUCKETS, attentionBucketCompareOutsideOwner as rule } from './lint/attention-bucket-compare-outside-owner.ts';
import { checkRule } from './lint/ast-rule.testkit.ts';

/** Hold the AST guard's bucket names to the contract (hearsay-tools/squawk#2275). */
describe('the attention-bucket-compare-outside-owner rule', () => {
  it('matches every attention bucket in both file sets', () => {
    expect([...ATTENTION_BUCKETS].sort()).toEqual(Object.keys(ATTENTION_RANK).sort());
    for (const ext of ['ts', 'tsx']) for (const bucket of Object.keys(ATTENTION_RANK)) {
      expect(checkRule(rule, `packages/web/src/bucket.${ext}`, `const x = attention.bucket === '${bucket}'`)).toHaveLength(1);
    }
  });

  it.each([
    ['packages/web/src/nested/bucket.ts', true],
    ['packages/cezar/src/bucket.tsx', true],
    ['packages/web/src/bucket.test.ts', false],
    ['packages/cezar/src/bucket.test.tsx', false],
    ['packages/cezar/src/bucket.testkit.ts', false],
    ['packages/cezar/src/bucket.testkit.tsx', true],
    ['packages/contract/src/bucket.ts', false],
    ['packages/web/e2e/bucket.ts', false],
  ])('reads %s: %s', (file, applies) => expect(rule.applies(file)).toBe(applies));
});
