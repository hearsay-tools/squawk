import { z } from 'zod';
import { REFERENCE_STATUS_MAX } from '@open-mercato/cezar-contract/github';
import { mergedPullRequestObservations } from '../../merge-observations.ts';
import { refStatusQuery } from './github-ref-status-query.ts';
import { reviewerKey, reviewerRefSchema } from './github-reviewer-ref.ts';
import { firstLine, rollupToChecks, type GraphqlRunner } from './github-shared.ts';
import type { ChecksGlyph } from './github-checks.ts';

/** Where a referenced PR or issue stands. Mirrored by `referenceStatusSchema` in the contract. */
export type ReferenceStatus =
  | 'draft'
  | 'review-required'
  | 'changes-requested'
  | 'checks-pending'
  | 'checks-failing'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'open'
  | 'completed'
  | 'not-planned';

export type GithubRefStatusData =
  | {
      available: true;
      prs: Record<number, ReferenceStatus>;
      issues: Record<number, ReferenceStatus>;
      conflicts?: number[];
      recheckAfterMs: number | null;
    }
  | { available: false; reason: string; recheckAfterMs: number | null };

/** Numbers per kind in one ref-status query. */
export const GH_REF_STATUS_MAX = REFERENCE_STATUS_MAX;

const ghRefStatusPrSchema = z
  .object({
    state: z.string(),
    url: z.unknown().optional(),
    mergedAt: z.unknown().optional(),
    isDraft: z.boolean().nullish(),
    reviewDecision: z.string().nullish(),
    mergeable: z.string().nullish(),
    commits: z
      .object({
        nodes: z.array(
          z.object({
            commit: z.object({
              committedDate: z.string().nullish(),
              parents: z
                .object({
                  totalCount: z.number(),
                  nodes: z.array(z.object({ committedDate: z.string().nullish() }).nullish()).nullish(),
                })
                .nullish(),
              statusCheckRollup: z.object({ state: z.string().nullish() }).nullish(),
            }),
          }),
        ),
      })
      .nullish(),
    reviews: z.object({ nodes: z.array(z.object({ submittedAt: z.string().nullish() })) }).nullish(),
    reviewRequests: z
      .object({
        totalCount: z.number(),
        nodes: z.array(z.object({ requestedReviewer: reviewerRefSchema }).nullish()).nullish(),
      })
      .nullish(),
    timelineItems: z
      .object({
        nodes: z
          .array(z.object({ createdAt: z.string().nullish(), requestedReviewer: reviewerRefSchema }).nullish())
          .nullish(),
      })
      .nullish(),
  })
  .nullish();

type GhRefStatusPr = NonNullable<z.infer<typeof ghRefStatusPrSchema>>;

function standingReviewRequestedAt(
  requests: GhRefStatusPr['reviewRequests'],
  timeline: GhRefStatusPr['timelineItems'],
): string | null {
  const standing = new Set<string>();
  for (const node of requests?.nodes ?? []) {
    const key = reviewerKey(node?.requestedReviewer);
    if (key) standing.add(key);
  }
  if (standing.size === 0) return null;
  let newest: string | null = null;
  for (const node of timeline?.nodes ?? []) {
    if (!node?.createdAt) continue;
    const key = reviewerKey(node.requestedReviewer);
    if (!key || !standing.has(key)) continue;
    if (!newest || isAfter(node.createdAt, newest)) newest = node.createdAt;
  }
  return newest;
}

const ghRefStatusIssueSchema = z.object({ state: z.string(), stateReason: z.string().nullish() }).nullish();
const ghRefStatusSchema = z.record(z.string(), z.unknown());

/**
 * Derive whose action is pending: terminal, draft, pending checks, current requested changes,
 * failing checks, review, then ready. Use dated review/work evidence; mergeability remains a
 * separate axis.
 */
export function derivePrReferenceStatus(pr: {
  state: string;
  isDraft?: boolean | null | undefined;
  reviewDecision?: string | null | undefined;
  checks: ChecksGlyph;
  headCommittedAt?: string | null | undefined;
  headParentCount?: number | null | undefined;
  headFirstParentCommittedAt?: string | null | undefined;
  changesRequestedAt?: string | null | undefined;
  reviewRequested?: boolean | null;
  reviewRequestedAt?: string | null;
}): ReferenceStatus {
  const state = pr.state.toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.checks === 'pending') return 'checks-pending';

  const decision = (pr.reviewDecision ?? '').toUpperCase();
  const changesRequested = decision === 'CHANGES_REQUESTED';
  const reRequested =
    pr.reviewRequested === true && (!pr.changesRequestedAt || isAfter(pr.reviewRequestedAt, pr.changesRequestedAt));
  const workCommittedAt =
    (pr.headParentCount ?? 1) < 2 ? pr.headCommittedAt : pr.headFirstParentCommittedAt;
  const pushed = isAfter(workCommittedAt, pr.changesRequestedAt);
  const answered = reRequested || pushed;
  if (changesRequested && !answered) return 'changes-requested';
  if (pr.checks === 'failing') return 'checks-failing';
  if (decision === 'APPROVED') return 'ready';
  if (changesRequested || decision === 'REVIEW_REQUIRED' || pr.reviewRequested === true) {
    return 'review-required';
  }
  return 'ready';
}

export type Mergeability = 'mergeable' | 'conflicting' | 'unknown';

export function mergeabilityOf(state: string, mergeable: string | null | undefined): Mergeability | undefined {
  if (state.toUpperCase() !== 'OPEN') return undefined;
  switch (mergeable?.toUpperCase()) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      return 'unknown';
  }
}

function isAfter(later?: string | null, earlier?: string | null): boolean {
  const a = later ? Date.parse(later) : NaN;
  const b = earlier ? Date.parse(earlier) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

export function deriveIssueReferenceStatus(issue: {
  state: string;
  stateReason?: string | null | undefined;
}): ReferenceStatus {
  if (issue.state.toUpperCase() !== 'CLOSED') return 'open';
  return (issue.stateReason ?? '').toUpperCase() === 'NOT_PLANNED' ? 'not-planned' : 'completed';
}

export interface ResolvedReference {
  kind: 'pr' | 'issue';
  status: ReferenceStatus;
  mergeable?: Mergeability;
}

export interface RefStatusBatch {
  resolved: Record<number, ResolvedReference>;
  failed: number[];
  reason?: string;
}

function refStatusGraphqlClean(
  raw: { errors?: unknown },
  repository: Record<string, unknown>,
  owner: string,
  name: string,
): boolean {
  return (!raw.errors || (Array.isArray(raw.errors) && raw.errors.length === 0)) &&
    typeof repository.nameWithOwner === 'string' && repository.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase();
}

function prHeadCommit(pr: GhRefStatusPr): NonNullable<NonNullable<GhRefStatusPr['commits']>['nodes'][0]>['commit'] | undefined {
  return pr.commits?.nodes[0]?.commit;
}

function prRollupChecks(head: ReturnType<typeof prHeadCommit>): ChecksGlyph {
  const rollup = head?.statusCheckRollup;
  return rollup ? rollupToChecks([{ state: rollup.state, status: null, conclusion: null }]) ?? null : null;
}

function resolvePrReference(
  pr: GhRefStatusPr,
  raw: { errors?: unknown },
  repository: Record<string, unknown>,
  owner: string,
  name: string,
  number: number,
): ResolvedReference {
  if (refStatusGraphqlClean(raw, repository, owner, name)) {
    mergedPullRequestObservations.observe({ owner, repo: name, number }, { ...pr, number });
  }
  const head = prHeadCommit(pr);
  const mergeability = mergeabilityOf(pr.state, pr.mergeable);
  return {
    kind: 'pr',
    status: derivePrReferenceStatus({
      state: pr.state,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      checks: prRollupChecks(head),
      headCommittedAt: head?.committedDate,
      headParentCount: head?.parents?.totalCount,
      headFirstParentCommittedAt: head?.parents?.nodes?.[0]?.committedDate,
      changesRequestedAt: pr.reviews?.nodes[0]?.submittedAt,
      reviewRequested: (pr.reviewRequests?.totalCount ?? 0) > 0,
      reviewRequestedAt: standingReviewRequestedAt(pr.reviewRequests, pr.timelineItems),
    }),
    ...(mergeability ? { mergeable: mergeability } : {}),
  };
}

function applyRefStatusNode(
  out: RefStatusBatch,
  node: { __typename?: string } | null | undefined,
  raw: { errors?: unknown },
  repository: Record<string, unknown>,
  owner: string,
  name: string,
  number: number,
): void {
  if (!node) return;
  if (node.__typename === 'PullRequest') {
    const pr = ghRefStatusPrSchema.parse(node);
    if (!pr) return;
    out.resolved[number] = resolvePrReference(pr, raw, repository, owner, name, number);
    return;
  }
  if (node.__typename === 'Issue') {
    const issue = ghRefStatusIssueSchema.parse(node);
    if (!issue) return;
    out.resolved[number] = { kind: 'issue', status: deriveIssueReferenceStatus(issue) };
  }
}

async function fetchRefStatusChunk(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  chunk: number[],
  out: RefStatusBatch,
): Promise<void> {
  try {
    const raw = JSON.parse(await runGraphql(refStatusQuery(chunk), { owner, name })) as {
      data?: { repository?: unknown };
      errors?: unknown;
    };
    const repository = ghRefStatusSchema.parse(raw?.data?.repository ?? {});
    chunk.forEach((number, index) => {
      applyRefStatusNode(
        out,
        repository[`r${index}`] as { __typename?: string } | null | undefined,
        raw,
        repository,
        owner,
        name,
        number,
      );
    });
  } catch (err) {
    out.failed.push(...chunk);
    out.reason ??= firstLine(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Status per NUMBER, resolved to whatever that number actually is.
 */
export async function fetchRefStatuses(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  numbers: number[],
  chunkSize = GH_REF_STATUS_MAX,
): Promise<RefStatusBatch> {
  const out: RefStatusBatch = { resolved: {}, failed: [] };
  if (numbers.length === 0) return out;

  for (let i = 0; i < numbers.length; i += chunkSize) {
    await fetchRefStatusChunk(runGraphql, owner, name, numbers.slice(i, i + chunkSize), out);
  }
  return out;
}
