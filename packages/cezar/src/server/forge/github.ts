import { refNumberFromUrl } from '@open-mercato/cezar-contract/run-search';
import { productEnv } from '../../core/product-env.ts';
import { mergedPullRequestObservations } from '../../merge-observations.ts';
import { createDraftPr } from './draft-pr.ts';
import { gh } from './github-cli.ts';
import { canonicalRepoRef, discoverRepoHandle, resolveRepoHandle } from './github-repo-handle.ts';
import { fetchGithubChecks } from './github-checks.ts';
import { fetchGithubCommentCounts, fetchGithubComments, fetchGithubItem, forgetGithubItem } from './github-comments.ts';
import { fetchGithub, fetchGithubProjects, searchGithubItems, viewGithubItem } from './github-list.ts';
import { fetchPrMergeState, lookupMergedPullRequests, mergePullRequest, readyPullRequest } from './github-mutations.ts';
import { fetchGithubPrDiff } from './github-pr-diff.ts';
import { fetchGithubRefStatus, forgetRefStatus, readCachedRefStatuses } from './github-ref-status.ts';
import {
  detectGithub,
  detectGithubCached,
  ghPrViewSchema,
  rollupToChecks,
  type GithubRepoRef,
} from './github-shared.ts';
import type { ForgeDriver, ForgePrStatus, ForgeRefKind } from './types.ts';

export type { RepoHandleDiscovery } from './repo-handle-discovery.ts';
export { createDraftPr, buildPrBody } from './draft-pr.ts';
export { parseOwnerName } from './github-cli.ts';
export { __clearRepoHandleCacheForTests, discoverRepoHandle, forgetRepoHandle, resolveRepoHandle } from './github-repo-handle.ts';
export { normalizeMergeState } from './github-merge-state.ts';
export {
  fetchTimelinePages,
  ghTimelineEventSchema,
  normalizeEvents,
  TIMELINE_BUDGET_MS,
  TIMELINE_EVENT_CAP,
  TIMELINE_EVENT_KINDS,
  TIMELINE_MAX_PAGES,
  TIMELINE_MIN_PAGE_MS,
} from './github-timeline.ts';
export { refNumberFromUrl } from '@open-mercato/cezar-contract/run-search';
export {
  detectGithubCached,
  ghCheckRunSchema,
  ghFailureReason,
  ghGraphqlArgs,
  HEALTH_AVAILABILITY_TTL_MS,
  rollupToChecks,
  type GithubData,
  type GithubItem,
  type GithubRepoRef,
  type GraphqlRunner,
} from './github-shared.ts';
export {
  fetchGithubPrDiff,
  fetchPrFilePages,
  GH_PR_DIFF_FILE_CAP,
  GH_PR_DIFF_JSON_CAP,
  GH_PR_PATCH_CAP,
  GithubPrNotFoundError,
  type PrFilesPageRunner,
} from './github-pr-diff.ts';
export {
  fetchGithub,
  fetchGithubProjects,
  fetchListConnection,
  GH_GRAPHQL_PAGE_MAX,
  GH_MAX_LIMIT,
  GH_SEARCH_MAX,
  searchGithubItems,
  viewGithubItem,
  type GithubPageRequest,
  type ListNode,
  type ListSide,
} from './github-list.ts';
export {
  __clearChecksCacheForTests,
  COMMIT_CHECKS_CHUNK,
  fetchCommitChecks,
  fetchGithubChecks,
  fetchPrChecks,
  GH_CHECKS_MAX,
  type ChecksGlyph,
  type GithubChecksData,
} from './github-checks.ts';
export {
  __clearCommentsCacheForTests,
  __clearGithubItemCacheForTests,
  fetchGithubCommentCounts,
  fetchGithubComments,
  fetchGithubItem,
  forgetGithubItem,
  mergeThread,
  normalizeComments,
  normalizeReviews,
  THREAD_ENTRY_CAP,
} from './github-comments.ts';
export {
  deriveIssueReferenceStatus,
  derivePrReferenceStatus,
  fetchRefStatuses,
  GH_REF_STATUS_MAX,
  mergeabilityOf,
  type GithubRefStatusData,
  type Mergeability,
  type ReferenceStatus,
  type RefStatusBatch,
  type ResolvedReference,
} from './github-ref-status-derive.ts';
export {
  __clearRefStatusCacheForTests,
  __seedRefStatusCacheForTests,
  fetchGithubRefStatus,
  forgetRefStatus,
  readCachedRefStatuses,
} from './github-ref-status.ts';
export {
  evictGithubProjectCaches,
  fetchMergedPullRequests,
  lookupMergedPullRequests,
  mergePreflightAllowed,
} from './github-mutations.ts';

const GH_PR_STATES: Record<string, ForgePrStatus['state']> = {
  MERGED: 'merged',
  CLOSED: 'closed',
};

/**
 * The GitHub forge driver — coordinates the sibling transport, list, comment, check, ref-status,
 * and mutation modules behind the `ForgeDriver` seam.
 */
export function createGithubDriver(repoRoot: string, repoRef: GithubRepoRef | null): ForgeDriver {
  return {
    kind: 'github',

    discoverRepository: (signal) => discoverRepoHandle(repoRoot, signal),
    resolveRepository: (signal) => resolveRepoHandle(repoRoot, signal),
    mergedPullRequests: (identities, signal) => lookupMergedPullRequests(repoRoot, identities, signal),

    list: (opts) => fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts),
    projects: (generation) => fetchGithubProjects(repoRoot, generation),
    item: (kind, number, opts) => fetchGithubItem(repoRoot, kind, number, opts?.refresh),
    comments: (kind, number, opts) => fetchGithubComments(repoRoot, kind, number, opts?.refresh),
    commentCounts: (kind, numbers, opts) => fetchGithubCommentCounts(repoRoot, kind, numbers, opts?.refresh),
    checks: (numbers) => fetchGithubChecks(repoRoot, numbers),
    refStatus: (input) => fetchGithubRefStatus(repoRoot, input),
    cachedRefStatuses: (numbers) => readCachedRefStatuses(repoRoot, numbers),
    branchPushed: (numbers) => {
      for (const number of numbers) forgetRefStatus(repoRoot, number);
    },

    detect: () => detectGithub(repoRoot),
    detectCached: () => detectGithubCached(repoRoot),

    listIssues: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts)).issues,
    listPRs: async (opts) => (await fetchGithub(repoRoot, opts?.refresh, opts?.limit, opts)).prs,
    searchItems: (kind, query, opts) => searchGithubItems(repoRoot, kind, query, opts?.limit),
    viewItem: (kind, number) => viewGithubItem(repoRoot, kind, number),
    prDiff: (number, opts) => fetchGithubPrDiff(repoRoot, number, opts?.refresh),

    createPR: async (input) => {
      const outcome = await createDraftPr(input);
      if (outcome.ok) {
        const createdNumber = refNumberFromUrl(outcome.url);
        if (createdNumber !== null) forgetRefStatus(repoRoot, createdNumber);
      }
      return outcome;
    },

    prStatus: async (branch) => {
      if (productEnv('DRY_RUN') === '1') return null;
      try {
        const out = await gh(repoRoot, ['pr', 'view', branch, '--json', 'number,url,state,isDraft,statusCheckRollup,mergedAt']);
        const pr = ghPrViewSchema.parse(JSON.parse(out));
        const ref = await canonicalRepoRef(repoRoot, repoRef);
        if (ref) mergedPullRequestObservations.observe({ ...ref, number: pr.number }, pr);
        return {
          number: pr.number,
          url: pr.url,
          state: GH_PR_STATES[pr.state.toUpperCase()] ?? 'open',
          isDraft: pr.isDraft,
          checks: rollupToChecks(pr.statusCheckRollup) ?? null,
        };
      } catch {
        return null;
      }
    },

    prMergeState: async (number, opts) => fetchPrMergeState(repoRoot, await canonicalRepoRef(repoRoot, repoRef), number, opts?.refresh),
    readyPR: (number, input) => readyPullRequest(repoRoot, repoRef, number, input),

    mergePR: async (number, input) => {
      const result = await mergePullRequest(repoRoot, repoRef, number, input);
      if (result.merged) {
        forgetRefStatus(repoRoot, number);
        forgetGithubItem(repoRoot, 'pr', number);
      }
      return result;
    },

    viewUrl: (kind: ForgeRefKind, ref: string | number): string | null => {
      if (!repoRef) return null;
      const base = `https://github.com/${repoRef.owner}/${repoRef.repo}`;
      const path = String(ref).split('/').map(encodeURIComponent).join('/');
      switch (kind) {
        case 'repo':
          return base;
        case 'issue':
          return `${base}/issues/${path}`;
        case 'pr':
          return `${base}/pull/${path}`;
        case 'branch':
          return `${base}/tree/${path}`;
        case 'commit':
          return `${base}/commit/${path}`;
      }
    },
  };
}
