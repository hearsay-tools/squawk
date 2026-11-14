import { describe, expect, it } from 'vitest';
import type { GithubMergeRequirements } from './github-merge-requirements.ts';
import { normalizeMergeState } from './github-merge-state.ts';

/** An open, approved, clean pull request as `gh pr view --json …` returns it. */
const readyPr = {
  number: 128,
  title: 'Ready PR',
  url: 'https://github.com/acme/demo/pull/128',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/ready',
  baseRefName: 'main',
  headRefOid: '0123456789abcdef0123456789abcdef01234567',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
/** `gh api repos/<owner>/<repo>` for a viewer with push access. */
const allMethodsPolicy = {
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  merge_commit_title: 'MERGE_MESSAGE',
  squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
};
const readableRules: GithubMergeRequirements = {
  readable: true,
  requiredChecks: ['test'],
  requiredApprovingReviews: 1,
  requiresThreadResolution: true,
  unresolvedThreads: 0,
  allowedMergeMethods: ['merge', 'squash', 'rebase'],
};
const unreadableRules: GithubMergeRequirements = { readable: false, requiredChecks: [] };

function verdict(pr: object, rules: GithubMergeRequirements = readableRules, policy: object = allMethodsPolicy) {
  const { state, mergeable, eligibility, blockers, canMerge, canOverride } = normalizeMergeState(pr, policy, rules);
  return { state, mergeable, eligibility, blockers, canMerge, canOverride };
}

describe('normalizeMergeState', () => {
  const open = { state: 'open', mergeable: 'mergeable' } as const;
  const ready = { ...open, eligibility: 'ready', blockers: [], canMerge: true, canOverride: false } as const;
  const blocked = (code: string, message: string, canOverride = true) =>
    ({ ...open, eligibility: 'blocked', blockers: [{ code, message }], canMerge: false, canOverride });
  const rulesUnknown = {
    ...open,
    eligibility: 'unknown',
    blockers: [{ code: 'rules-unknown', message: 'GitHub could not confirm review and branch-protection requirements.' }],
    canMerge: false,
    canOverride: true,
  };
  const pending = {
    ...open,
    eligibility: 'pending',
    blockers: [{ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' }],
    canMerge: false,
    canOverride: true,
  };
  const unconfirmed = (mergeable: 'mergeable' | 'unknown' = 'mergeable', canOverride = true) => ({
    state: 'open',
    mergeable,
    eligibility: 'unknown',
    blockers: [{ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' }],
    canMerge: false,
    canOverride,
  });
  const failingCheck = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' };
  const runningCheck = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' };

  it.each([
    ['a clean pull request is ready', readyPr, readableRules, ready],
    ['GitHub reports pre-receive hooks', { ...readyPr, mergeStateStatus: 'HAS_HOOKS' }, readableRules, ready],
    ['a merged pull request is terminal', { ...readyPr, state: 'MERGED', mergedAt: '2026-11-01T10:00:00Z' }, readableRules, {
      ...open, state: 'merged', eligibility: 'terminal',
      blockers: [{ code: 'terminal', message: 'This pull request is merged.' }], canMerge: false, canOverride: false,
    }],
    ['a closed pull request is terminal', { ...readyPr, state: 'CLOSED' }, readableRules, {
      ...open, state: 'closed', eligibility: 'terminal',
      blockers: [{ code: 'terminal', message: 'This pull request is closed.' }], canMerge: false, canOverride: false,
    }],
    ['a draft is blocked', { ...readyPr, isDraft: true, mergeStateStatus: 'DRAFT' }, readableRules,
      blocked('draft', 'Mark the pull request ready for review before merging.', false)],
    ['a conflicting pull request is blocked', { ...readyPr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, readableRules, {
      ...blocked('conflicts', 'Conflicts must be resolved before merging.', false), mergeable: 'conflicting',
    }],
    ['a failing check blocks', { ...readyPr, mergeStateStatus: 'BLOCKED', statusCheckRollup: [failingCheck] }, readableRules,
      blocked('checks-failing', 'One or more checks are failing.')],
    ['requested changes block', { ...readyPr, mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }, readableRules,
      blocked('reviews', 'Changes were requested.')],
    ['a missing required review blocks', { ...readyPr, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, readableRules,
      blocked('reviews', 'A required review is missing.')],
    ['unresolved required threads block', { ...readyPr, mergeStateStatus: 'BLOCKED' }, { ...readableRules, unresolvedThreads: 2 },
      blocked('review-threads', 'Required review threads must be resolved before merging.')],
    ['unreadable branch rules are unconfirmed', readyPr, unreadableRules, rulesUnknown],
    ['an unreadable thread count is unconfirmed', readyPr, { ...readableRules, unresolvedThreads: null }, rulesUnknown],
    ['a required check with an unknown outcome is unconfirmed',
      { ...readyPr, statusCheckRollup: [{ ...failingCheck, conclusion: 'STALE' }] }, readableRules, rulesUnknown],
    ['a running check is pending', { ...readyPr, mergeStateStatus: 'BLOCKED', statusCheckRollup: [runningCheck] }, readableRules, pending],
    ['a required check GitHub has not reported is pending', readyPr, { ...readableRules, requiredChecks: ['test', 'lint'] }, pending],
    ['an unstable merge state is pending',{ ...readyPr, mergeStateStatus: 'UNSTABLE' }, readableRules, pending],
    ['a blocked merge state is unconfirmed', { ...readyPr, mergeStateStatus: 'BLOCKED' }, readableRules, unconfirmed()],
    ['a clean status is not trusted while mergeability is computed', { ...readyPr, mergeable: 'UNKNOWN' }, readableRules,
      unconfirmed('unknown')],
    ['a missing merge state status is unconfirmed', { ...readyPr, mergeStateStatus: null }, readableRules, unconfirmed()],
    ['branch rules that allow no enabled method are unconfirmed', readyPr, { ...readableRules, allowedMergeMethods: [] },
      unconfirmed('mergeable', false)],
  ])('%s', (_name, pr, rules, expected) => {
    expect(verdict(pr, rules)).toEqual(expected);
  });

  it.each([
    ['SUCCESS', 'passing'], ['NEUTRAL', 'passing'], ['SKIPPED', 'passing'],
    ['FAILURE', 'failing'], ['TIMED_OUT', 'failing'], ['ACTION_REQUIRED', 'failing'], ['CANCELLED', 'failing'],
    ['STALE', 'unknown'], ['STARTUP_FAILURE', 'unknown'],
  ])('shows a completed check run with conclusion %s as %s', (conclusion, state) => {
    const pr = { ...readyPr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }] };
    expect(normalizeMergeState(pr, allMethodsPolicy, readableRules).checks).toEqual([{ name: 'test', state, required: true }]);
  });

  it.each(['IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'PENDING'])(
    'shows a check run with status %s as pending',
    (status) => {
      const pr = { ...readyPr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status, conclusion: '' }] };
      expect(normalizeMergeState(pr, allMethodsPolicy, readableRules).checks)
        .toEqual([{ name: 'test', state: 'pending', required: true }]);
    },
  );

  it.each([
    ['SUCCESS', 'passing'], ['FAILURE', 'failing'], ['ERROR', 'failing'], ['PENDING', 'pending'], ['EXPECTED', 'pending'],
  ])('shows a commit status with state %s as %s', (status, state) => {
    const pr = { ...readyPr, statusCheckRollup: [{ __typename: 'StatusContext', context: 'test', state: status }] };
    expect(normalizeMergeState(pr, allMethodsPolicy, readableRules).checks).toEqual([{ name: 'test', state, required: true }]);
  });

  it('lists reported checks with web links only, then required checks GitHub has not reported', () => {
    const pr = {
      ...readyPr,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/1' },
        { __typename: 'StatusContext', context: 'ci/jenkins', state: 'SUCCESS', targetUrl: 'http://jenkins.local/2' },
        { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS', targetUrl: 'javascript:alert(1)' },
      ],
    };
    expect(normalizeMergeState(pr, allMethodsPolicy, { ...readableRules, requiredChecks: ['test', 'lint'] }).checks).toEqual([
      { name: 'test', state: 'passing', required: true, url: 'https://ci.example/1' },
      { name: 'ci/jenkins', state: 'passing', required: false, url: 'http://jenkins.local/2' },
      { name: 'deploy', state: 'passing', required: false },
      { name: 'lint', state: 'pending', required: true },
    ]);
  });

  it('gives a malformed rollup entry without a name or context a placeholder name', () => {
    const pr = { ...readyPr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    expect(normalizeMergeState(pr, allMethodsPolicy, { ...readableRules, requiredChecks: [] }).checks)
      .toEqual([{ name: 'Check', state: 'passing', required: false }]);
  });

  it('does not know which checks are required when branch rules are unreadable', () => {
    expect(normalizeMergeState(readyPr, allMethodsPolicy, unreadableRules).checks)
      .toEqual([{ name: 'test', state: 'passing', required: null }]);
    expect(normalizeMergeState({ ...readyPr, statusCheckRollup: null }, allMethodsPolicy, unreadableRules).checks).toEqual([]);
  });

  it.each([
    ['prefers squash when the repository sets a squash title', allMethodsPolicy, readableRules,
      { methods: ['squash', 'merge', 'rebase'], defaultMethod: 'squash' }],
    ['prefers a merge commit when only its title is set',
      { ...allMethodsPolicy, squash_merge_commit_title: null }, readableRules,
      { methods: ['squash', 'merge', 'rebase'], defaultMethod: 'merge' }],
    ['ignores the squash title when squash is disabled',
      { ...allMethodsPolicy, allow_squash_merge: false, merge_commit_title: null }, readableRules,
      { methods: ['merge', 'rebase'], defaultMethod: 'merge' }],
    ['ignores the merge title when branch rules forbid merge commits',
      { ...allMethodsPolicy, squash_merge_commit_title: null }, { ...readableRules, allowedMergeMethods: ['rebase', 'squash'] } satisfies GithubMergeRequirements,
      { methods: ['squash', 'rebase'], defaultMethod: 'squash' }],
    ['falls back to the first offered method without titles',
      { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true }, readableRules,
      { methods: ['rebase'], defaultMethod: 'rebase' }],
    ['offers no method to a viewer GitHub hides the merge settings from', {}, readableRules,
      { methods: [], defaultMethod: null }],
    ['offers every enabled method when branch rules are unreadable',
      { ...allMethodsPolicy, merge_commit_title: null, squash_merge_commit_title: null }, unreadableRules,
      { methods: ['squash', 'merge', 'rebase'], defaultMethod: 'squash' }],
  ])('%s', (_name, policy, rules, expected) => {
    const { methods, defaultMethod } = normalizeMergeState(readyPr, policy, rules);
    expect({ methods, defaultMethod }).toEqual(expected);
  });
});
