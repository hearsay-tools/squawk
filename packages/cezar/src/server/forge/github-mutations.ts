import { z } from 'zod';
import type { ArchivePullRequestIdentity, MergedPullRequest } from '@open-mercato/cezar-contract/runs';
import { activeWorkflowRunsArgs, parseActiveWorkflowRuns } from '../../ci-wait/github.ts';
import { productEnv } from '../../core/product-env.ts';
import { matchesGithubPullRequest, mergedPullRequestObservations } from '../../merge-observations.ts';
import { pullRequestKey } from '../../runs/pull-requests.ts';
import { gh, githubContext } from './github-cli.ts';
import { evictGithubCommentCaches } from './github-comments.ts';
import { evictGithubListCaches } from './github-list.ts';
import { fetchGithubMergeRequirements } from './github-merge-requirements.ts';
import { mergePrSchema, normalizeMergeState } from './github-merge-state.ts';
import { mergedPullRequestChunk } from './github-merged-pr-chunk.ts';
import { canonicalRepoRef, forgetRepoHandle } from './github-repo-handle.ts';
import { githubRequestGate } from './github-request-gate.ts';
import {
  firstLine,
  ghMergeResultSchema,
  type GithubRepoRef,
  type GraphqlRunner,
} from './github-shared.ts';
import type {
  ForgeMergeInput,
  ForgeMergeResult,
  ForgePrMergeState,
  ForgePrMergeStateResult,
} from './types.ts';

const mergeStateCache = new Map<string, { at: number; value: ForgePrMergeStateResult }>();
const mergeInflight = new Set<string>();
const MERGE_CACHE_MS = 15_000;

export async function fetchPrMergeState(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  refresh = false,
): Promise<ForgePrMergeStateResult> {
  if (productEnv('DRY_RUN') === '1') {
    return {
      available: true,
      mergeState: normalizeMergeState(
        {
          number,
          title: 'Dry-run pull request',
          url: `https://github.com/mock/repo/pull/${number}`,
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feat/dry-run',
          baseRefName: 'main',
          headRefOid: '0123456789abcdef0123456789abcdef01234567',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/mock/repo/actions' }],
        },
        { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true },
        { readable: true, requiredChecks: ['test'] },
      ),
    };
  }
  if (!repoRef) return { available: false, reason: 'GitHub remote could not be resolved' };
  const key = `${repoRoot}:${number}`;
  const hit = mergeStateCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < MERGE_CACHE_MS) return hit.value;
  try {
    const prOut = await gh(repoRoot, [
      'pr', 'view', String(number), '--json',
      'number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt',
    ]);
    const parsedPr = mergePrSchema.parse(JSON.parse(prOut));
    if (!matchesGithubPullRequest({ ...repoRef, number }, parsedPr)) { forgetRepoHandle(repoRoot); return { available: false, reason: 'GitHub returned a different pull request.' }; }
    mergedPullRequestObservations.observe({ ...repoRef, number }, parsedPr);
    const [policyOut, requirements] = await Promise.all([
      gh(repoRoot, ['api', `repos/${repoRef.owner}/${repoRef.repo}`]),
      fetchGithubMergeRequirements((args) => gh(repoRoot, args), repoRef.owner, repoRef.repo, parsedPr.baseRefName, number),
    ]);
    const value: ForgePrMergeStateResult = {
      available: true,
      mergeState: normalizeMergeState(parsedPr, JSON.parse(policyOut), requirements),
    };
    mergeStateCache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    return { available: false, reason: firstLine(error instanceof Error ? error.message : String(error)) };
  }
}

export function evictGithubProjectCaches(repoRoot: string): void {
  const contextKey = githubContext(repoRoot).key;
  evictGithubListCaches(contextKey);
  evictGithubCommentCaches(contextKey);
  mergeStateCache.forEach((_value, key) => {
    if (key.startsWith(`${repoRoot}:`)) mergeStateCache.delete(key);
  });
}

function mergeCancelledResult(): ForgeMergeResult {
  return { merged: false, status: 409, error: 'Automatic merging was cancelled.', code: 'cancelled' };
}

function mergeConflictResult(error: string, code: string, current: ForgePrMergeState): ForgeMergeResult {
  return { merged: false, status: 409, error, code, current };
}

function mergePullRequestPreflight(current: ForgePrMergeState, input: ForgeMergeInput): ForgeMergeResult | null {
  if (current.headSha !== input.expectedHeadSha) {
    return mergeConflictResult('The pull request head changed. Review the new commits before merging.', 'stale-head', current);
  }
  if (input.expectedHeadRef !== undefined && current.headRef !== input.expectedHeadRef) {
    return mergeConflictResult('The pull request branch changed.', 'stale-branch', current);
  }
  if (input.requirePassingChecks && (current.checks.length === 0 || current.checks.some(check => check.state !== 'passing'))) {
    return mergeConflictResult('Automatic merging requires at least one check and every current-head check passing.', 'checks-not-passing', current);
  }
  if (!current.methods.includes(input.method)) {
    return mergeConflictResult('That merge method is no longer enabled.', 'disabled-method', current);
  }
  if (!mergePreflightAllowed(current, !input.requirePassingChecks && input.overrideRules)) {
    return mergeConflictResult(current.blockers[0]?.message ?? 'The pull request is not eligible to merge.', current.eligibility, current);
  }
  return null;
}

async function mergeActiveCiConflict(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  current: ForgePrMergeState,
  input: ForgeMergeInput,
): Promise<ForgeMergeResult | null> {
  if (!(input.requirePassingChecks && productEnv('DRY_RUN') !== '1')) return null;
  if (!repoRef) return { merged: false, status: 404, error: 'GitHub repository not found.' };
  const active = parseActiveWorkflowRuns(await gh(repoRoot, activeWorkflowRunsArgs({
    repository: `${repoRef.owner}/${repoRef.repo}`, headSha: current.headSha,
  })));
  if (input.canProceed?.() === false) return mergeCancelledResult();
  if (active) return mergeConflictResult('Waiting for active CI workflows on the current PR head.', 'checks-active', current);
  return null;
}

async function executeGithubMerge(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ForgeMergeInput,
  current: ForgePrMergeState,
): Promise<ForgeMergeResult> {
  if (productEnv('DRY_RUN') === '1') {
    evictGithubProjectCaches(repoRoot);
    return { merged: true, number, url: current.url, method: input.method, mergeCommitSha: 'abcdef0123456789abcdef0123456789abcdef01' };
  }
  if (!repoRef) return { merged: false, status: 404, error: 'GitHub repository not found.' };
  if (input.canProceed?.() === false) return mergeCancelledResult();
  const out = await gh(repoRoot, [
    'api', '--method', 'PUT', `repos/${repoRef.owner}/${repoRef.repo}/pulls/${number}/merge`,
    '-f', `merge_method=${input.method}`, '-f', `sha=${input.expectedHeadSha}`,
  ]);
  const result = ghMergeResultSchema.parse(JSON.parse(out));
  if (!result.merged) return mergeConflictResult(result.message ?? 'GitHub refused the merge.', 'github-blocked', current);
  evictGithubProjectCaches(repoRoot);
  return { merged: true, number, url: current.url, method: input.method, ...(result.sha ? { mergeCommitSha: result.sha } : {}) };
}

function mergePullRequestFailure(error: unknown): ForgeMergeResult {
  const message = firstLine(error instanceof Error ? error.message : String(error));
  const status = /403|permission|forbidden/i.test(message) ? 403 : /404|not found/i.test(message) ? 404 : 502;
  return { merged: false, status, error: status === 403 ? 'GitHub permission denied.' : status === 404 ? 'Pull request or repository not found.' : 'GitHub could not complete the merge.' };
}

export async function mergePullRequest(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ForgeMergeInput,
): Promise<ForgeMergeResult> {
  const key = `${repoRoot}:${number}`;
  if (mergeInflight.has(key)) return { merged: false, status: 409, error: 'A merge is already in progress.', code: 'concurrent' };
  mergeInflight.add(key);
  try {
    if (input.canProceed?.() === false) return mergeCancelledResult();
    const ref = await canonicalRepoRef(repoRoot, repoRef);
    const fresh = await fetchPrMergeState(repoRoot, ref, number, true);
    if (input.canProceed?.() === false) return mergeCancelledResult();
    if (!fresh.available) return { merged: false, status: 502, error: fresh.reason };
    const current = fresh.mergeState;
    const preflight = mergePullRequestPreflight(current, input);
    if (preflight) return preflight;
    const ciConflict = await mergeActiveCiConflict(repoRoot, ref, current, input);
    if (ciConflict) return ciConflict;
    return await executeGithubMerge(repoRoot, ref, number, input, current);
  } catch (error) {
    return mergePullRequestFailure(error);
  } finally {
    mergeInflight.delete(key);
  }
}

export function mergePreflightAllowed(current: ForgePrMergeState, overrideRules = false): boolean {
  return current.canMerge || (overrideRules && current.canOverride);
}

type ReadyPullRequestInput = { expectedHeadSha: string; expectedHeadRef: string; canProceed?: () => boolean };

function readyCancelledResult(): ForgePrMergeStateResult {
  return { available: false, reason: 'Marking the pull request ready was cancelled.' };
}

function readyPullRequestInputInvalid(number: number, input: ReadyPullRequestInput): boolean {
  return !Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(input.expectedHeadSha) || !input.expectedHeadRef;
}

function readyPullRequestIdentityConflict(
  pr: { number: number; url: string; state: string; isDraft: boolean; headRefName: string; headRefOid: string },
  repoRef: GithubRepoRef,
  number: number,
  input: ReadyPullRequestInput,
): ForgePrMergeStateResult | null {
  if (!matchesGithubPullRequest({ ...repoRef, number }, pr)) return { available: false, reason: 'GitHub returned a different pull request.' };
  if (pr.headRefOid !== input.expectedHeadSha) return { available: false, reason: 'The pull request head changed.' };
  if (pr.headRefName !== input.expectedHeadRef) return { available: false, reason: 'The pull request branch changed.' };
  if (pr.state !== 'OPEN') return { available: false, reason: 'The pull request is no longer open.' };
  return null;
}

async function markDraftPullRequestReady(
  repoRoot: string,
  repoRef: GithubRepoRef,
  number: number,
  input: ReadyPullRequestInput,
): Promise<ForgePrMergeStateResult | null> {
  if (input.canProceed?.() === false) return readyCancelledResult();
  await gh(repoRoot, ['pr', 'ready', String(number), '--repo', `github.com/${repoRef.owner}/${repoRef.repo}`]);
  evictGithubProjectCaches(repoRoot);
  if (input.canProceed?.() === false) return readyCancelledResult();
  return null;
}

async function readyPullRequestOwnership(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ReadyPullRequestInput,
): Promise<ForgePrMergeStateResult | null> {
  if (!repoRef) return { available: false, reason: 'GitHub remote could not be resolved' };
  const pr = mergePrSchema.pick({ number: true, url: true, state: true, isDraft: true, headRefName: true, headRefOid: true }).parse(JSON.parse(await gh(repoRoot, [
    'pr', 'view', String(number), '--json', 'number,url,state,isDraft,headRefName,headRefOid',
  ])));
  if (input.canProceed?.() === false) return readyCancelledResult();
  const identity = readyPullRequestIdentityConflict(pr, repoRef, number, input);
  if (identity) return identity;
  if (!pr.isDraft) return null;
  return markDraftPullRequestReady(repoRoot, repoRef, number, input);
}

async function refreshReadyPullRequestState(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ReadyPullRequestInput,
): Promise<ForgePrMergeStateResult> {
  const fresh = await fetchPrMergeState(repoRoot, repoRef, number, true);
  if (input.canProceed?.() === false) return readyCancelledResult();
  if (fresh.available && fresh.mergeState.headSha !== input.expectedHeadSha) return { available: false, reason: 'The pull request head changed.' };
  if (fresh.available && fresh.mergeState.headRef !== input.expectedHeadRef) return { available: false, reason: 'The pull request branch changed.' };
  return fresh;
}

/** gh has no compare-and-swap ready operation. Check ownership immediately before marking ready,
 * then refresh again; the later merge has its own head guard and GitHub's atomic SHA check. */
export async function readyPullRequest(
  repoRoot: string,
  repoRef: GithubRepoRef | null,
  number: number,
  input: ReadyPullRequestInput,
): Promise<ForgePrMergeStateResult> {
  if (readyPullRequestInputInvalid(number, input)) {
    return { available: false, reason: 'A valid pull request, head SHA and task branch are required.' };
  }
  const key = `${repoRoot}:${number}`;
  if (mergeInflight.has(key)) return { available: false, reason: 'A pull request mutation is already in progress.' };
  mergeInflight.add(key);
  try {
    if (input.canProceed?.() === false) return readyCancelledResult();
    const ref = await canonicalRepoRef(repoRoot, repoRef);
    if (productEnv('DRY_RUN') !== '1') {
      const ownership = await readyPullRequestOwnership(repoRoot, ref, number, input);
      if (ownership) return ownership;
    }
    return await refreshReadyPullRequestState(repoRoot, ref, number, input);
  } catch {
    return { available: false, reason: 'GitHub could not mark the pull request ready for review.' };
  } finally {
    mergeInflight.delete(key);
  }
}

/** Strict archive authority: no partial GraphQL success, redirects, guessed identity or date. */
export async function fetchMergedPullRequests(runGraphql: GraphqlRunner, identities: readonly ArchivePullRequestIdentity[]): Promise<MergedPullRequest[]> {
  const repositories = new Map<string, ArchivePullRequestIdentity[]>();
  for (const identity of new Map(identities.map(pr => [pullRequestKey(pr), pr])).values()) {
    const key = `${identity.owner}/${identity.repo}`;
    repositories.set(key, [...(repositories.get(key) ?? []), identity]);
  }
  const merged: MergedPullRequest[] = [];
  for (const [repository, prs] of repositories) {
    for (let offset = 0; offset < prs.length; offset += 25) {
      const chunk = prs.slice(offset, offset + 25);
      const response = await mergedPullRequestChunk(runGraphql, chunk);
      const parsed = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ nameWithOwner: z.string() }).passthrough().nullable() }) }).safeParse(response);
      if (!parsed.success || parsed.data.errors?.length || parsed.data.data.repository?.nameWithOwner.toLowerCase() !== repository.toLowerCase()) continue;
      for (const pr of chunk) {
        const fact = mergedPullRequestObservations.observe(pr, parsed.data.data.repository[`pr${pr.number}`]);
        if (fact) merged.push(fact);
      }
    }
  }
  return merged;
}

export async function lookupMergedPullRequests(repoRoot: string, identities: ArchivePullRequestIdentity[], signal: AbortSignal): Promise<MergedPullRequest[]> {
  signal.throwIfAborted();
  if (productEnv('DRY_RUN') === '1') return [];
  const unique = [...new Map(identities.map(pr => [pullRequestKey(pr), pr])).values()];
  const known = unique.flatMap(pr => mergedPullRequestObservations.get(pr) ?? []);
  const missing = unique.filter(pr => !mergedPullRequestObservations.get(pr));
  if (missing.length === 0) return known;
  const context = githubContext(repoRoot);
  const fetched = await fetchMergedPullRequests(async (query, variables) => {
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
    return githubRequestGate.run(() => gh(repoRoot, args, 15_000, signal, context), { signal, whenPaused: 'throw' });
  }, missing);
  return [...known, ...fetched];
}
