import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { isOriginatingIssueCurrent, restoreOriginatingIssue } from './run-references.ts';

it('checks the exact restoration result, including absent and explicit undefined keys', () => {
  for (const task of ['Implement issue 123', 'Compare two tasks']) {
    for (const markerRefs of [undefined, { issue: 456 }]) {
      for (const issueNumber of [undefined, 123, 456]) {
        for (const fields of [
          {}, { referencedIssueNumberSeeded: undefined }, { referencedIssueNumberSeeded: true },
          { referencedIssueUrl: undefined },
          { referencedIssueUrl: 'https://github.com/o/r/issues/123' },
          { referencedIssueCandidates: ['https://github.com/o/r/issues/123'] },
        ]) {
          const run = makeRunRecord({ task, markerRefs, issueNumber, ...fields });
          const projected = { ...run };
          restoreOriginatingIssue(projected);
          expect(isOriginatingIssueCurrent(run)).toBe(isDeepStrictEqual(projected, run));
        }
      }
    }
  }
});
