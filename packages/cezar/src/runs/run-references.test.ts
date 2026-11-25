import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { isOriginatingIssueCurrent, originatingIssue, restoreOriginatingIssue } from './run-references.ts';

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

describe('originatingIssue across automation templates and skill prompt shapes (hearsay-tools/squawk#2375)', () => {
  const automation = (event: 'issue.opened' | 'issue.labeled' | 'pull_request.opened', githubUrl: string) => ({
    automationId: 'auto-1', automationRevision: 1, receiptId: 'r-1', event, githubUrl,
  });

  it.each([
    // Main CI — guarded repair automation (docs/sdlc/main-ci-repair.md, hearsay-tools/squawk#2375)
    ['main CI repair automation (cezarion)', 'Handle main CI failure https://github.com/hearsay-tools/cezarion/issues/1733 in hearsay-tools/cezarion. Verify source provenance.', undefined, 1733],
    ['main CI repair automation (squawk)', 'Handle main CI failure https://github.com/hearsay-tools/squawk/issues/1733 in hearsay-tools/squawk.', undefined, 1733],
    // Friction handling automations (.github/scripts/friction-policy.cjs:buildAutomations)
    ['friction automatic automation', 'Handle friction issue https://github.com/hearsay-tools/squawk/issues/1200 in hearsay-tools/squawk. Expected handling label: friction-auto.', undefined, 1200],
    ['friction guarded automation', 'Handle friction issue https://github.com/hearsay-tools/squawk/issues/1200 in hearsay-tools/squawk. Expected handling label: friction-guarded.', undefined, 1200],
    ['friction design automation', 'Handle friction issue https://github.com/hearsay-tools/squawk/issues/1200 in hearsay-tools/squawk. Expected handling label: friction-design.', undefined, 1200],
    // Flaky-test automation (docs/sdlc/main-ci-repair.md)
    ['flaky-test automation', 'Handle flaky-test report https://github.com/hearsay-tools/squawk/issues/1200 and reproduce the flake.', undefined, 1200],
    // CLI doc example (docs/areas/cli.md): Agent triage (`--prompt 'Triage #{{github.number}}'`)
    ['CLI agent triage automation', 'Triage #1200', { markerRefs: { issue: 1216 } }, 1200],
    // Automation testkit shape (packages/cezar/src/automations/task-template.testkit.ts)
    ['automation testkit review issue', 'Review #1200: Title at https://github.com/o/r/issues/1200', { markerRefs: { issue: 1216 } }, 1200],
    // GitHub issue automation provenance even when custom prompt omits the issue ref
    ['GitHub issue automation provenance', 'Run the diagnostic checklist for this report.', { automation: automation('issue.labeled', 'https://github.com/hearsay-tools/squawk/issues/1733') }, 1733],
    // Cockpit GitHub tab issue handoff (packages/web/src/lib/github-task.ts:githubTaskRef)
    ['GitHub tab issue handoff', 'Fix GitHub issue #1200: Title\n\nhttps://github.com/o/r/issues/1200', undefined, 1200],
    // Campaign skill worker briefs (.ai/skills/campaign/references/cleanup-worker-brief.md, feature-delivery.md)
    ['campaign cleanup worker brief', 'Work hearsay-tools/squawk#1200 to a ready PR with green CI.', { markerRefs: { issue: 1216 } }, 1200],
    ['campaign feature worker brief (slug)', 'Implement hearsay-tools/squawk#1200 from approved plan .ai/specs/plan.md.', { markerRefs: { issue: 1216 } }, 1200],
    ['campaign feature worker brief (URL)', 'Implement https://github.com/hearsay-tools/squawk/issues/1200 from approved plan.', undefined, 1200],
    // Scheduled / digest / PR templates — NOT issue-originating
    ['friction daily digest schedule', 'Run the friction digest for hearsay-tools/squawk. Today is 2026-11-25.', undefined, undefined],
    ['CLI weekday triage schedule', 'Triage new issues', undefined, undefined],
    ['CLI rollout schedule', 'Check the rollout', undefined, undefined],
    ['CLI follow-up schedule', 'Follow up on the migration', undefined, undefined],
    ['automation schema PR review example', 'Review pull request #1200 (Title) at https://github.com/o/r/pull/1200: read the diff, run the tests, and post your findings as a review.', { automation: automation('pull_request.opened', 'https://github.com/o/r/pull/1200'), markerRefs: { issue: 1216 } }, undefined],
    ['GitHub tab PR handoff', 'Address GitHub pull request #1200: Title\n\nhttps://github.com/o/r/pull/1200', { markerRefs: { issue: 1216 } }, undefined],
    // Background mentions, comparisons, PR-for-issue, and plain counts stay replaceable
    ['comparison prompt', 'Compare against issue #1200 while fixing issue #1216', { markerRefs: { issue: 1216 } }, undefined],
    ['multi-repo comparison', 'Compare https://github.com/one/repo/issues/1200 and https://github.com/two/repo/issues/1200', { markerRefs: { issue: 1216 } }, undefined],
    ['see-background mention', 'See #1200 for background, then clean up the logs', { markerRefs: { issue: 1216 } }, undefined],
    ['check-differs-from mention', 'Check why this differs from https://github.com/o/r/issues/1200 and file a new issue', { markerRefs: { issue: 1216 } }, undefined],
    ['PR review mentioning issue', 'Review PR #900 for issue #1200', { markerRefs: { issue: 1216 } }, undefined],
    ['plain item count after verb', 'Fix 2 bugs in the parser', { markerRefs: { issue: 1216 } }, undefined],
  ])('%s → %j', (_label, task, extra, expected) => {
    const run = makeRunRecord({ task, ...extra });
    expect(originatingIssue(run)).toBe(expected);
  });
});
