import { z } from 'zod';
import {
  GITHUB_COMMENT_COUNTS_MAX,
  type GithubCommentCountsData,
  type GithubItemResponse,
} from '@open-mercato/cezar-contract/github';
import { defined } from '../../core/defined.ts';
import { productEnv } from '../../core/product-env.ts';
import { gh, githubContext } from './github-cli.ts';
import { resolveRepoHandle } from './github-repo-handle.ts';
import { fetchTimelinePages, normalizeEvents, TIMELINE_PER_PAGE, type TimelinePages } from './github-timeline.ts';
import { viewGithubItem } from './github-list.ts';
import { CHECKS_CACHE_MAX, fetchCommitChecks } from './github-checks.ts';
import {
  CACHE_MS,
  detectGithub,
  firstLine,
  ghFailureReason,
  ghGraphqlArgs,
  mockGithub,
  refStatusGraphql,
  resolveRepoHandleStrict,
  type GraphqlRunner,
} from './github-shared.ts';
import type { ForgeComment, ForgeCommentsData, ForgeTimelineEvent } from './types.ts';

const ghCommentUser = z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish();
const ghIssueCommentSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  created_at: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
});
const ghReviewSchema = z.object({
  id: z.number(),
  user: ghCommentUser,
  body: z.string().nullish(),
  state: z.string(),
  submitted_at: z.string().nullish(),
  html_url: z.string(),
});

const REVIEW_STATE: Record<string, ForgeComment['reviewState']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** First 200 thread entries, then `truncated`; each body sliced to 8 000 chars. */
export const THREAD_ENTRY_CAP = 200;
const COMMENT_BODY_CAP = 8_000;

/** `gh api …/issues/{n}/comments` JSON → `ForgeComment[]`. Exported for unit tests. */
export function normalizeComments(raw: unknown): ForgeComment[] {
  return z.array(ghIssueCommentSchema).parse(raw).map((c) => defined({
    id: c.id,
    author: c.user?.login ?? '?',
    avatarUrl: c.user?.avatar_url ?? undefined,
    createdAt: c.created_at,
    body: (c.body ?? '').slice(0, COMMENT_BODY_CAP),
    kind: 'comment' as const,
    url: c.html_url,
  }));
}

/** `gh api …/pulls/{n}/reviews` JSON → `ForgeComment[]`. Exported for unit tests. */
export function normalizeReviews(raw: unknown): ForgeComment[] {
  return z
    .array(ghReviewSchema)
    .parse(raw)
    .filter((r) => {
      const state = r.state.toUpperCase();
      const emptyBody = (r.body ?? '').trim().length === 0;
      return !(emptyBody && (state === 'COMMENTED' || state === 'PENDING'));
    })
    .map((r) => defined({
      id: r.id,
      author: r.user?.login ?? '?',
      avatarUrl: r.user?.avatar_url ?? undefined,
      createdAt: r.submitted_at ?? '',
      body: (r.body ?? '').slice(0, COMMENT_BODY_CAP),
      kind: 'review' as const,
      reviewState: REVIEW_STATE[r.state.toUpperCase()],
      url: r.html_url,
    }));
}

/** Merge comment/review lists chronologically (oldest first) and apply the entry cap. */
export function mergeThread(
  parts: ForgeComment[][],
  cap = THREAD_ENTRY_CAP,
): { comments: ForgeComment[]; truncated: boolean } {
  const all = parts.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const truncated = all.length > cap;
  return { comments: truncated ? all.slice(0, cap) : all, truncated };
}

const commentsCache = new Map<string, { at: number; data: ForgeCommentsData }>();
const COMMENTS_CACHE_MAX = 50;

function cacheComments(key: string, data: ForgeCommentsData): void {
  commentsCache.delete(key);
  commentsCache.set(key, { at: Date.now(), data });
  while (commentsCache.size > COMMENTS_CACHE_MAX) {
    const oldest = commentsCache.keys().next().value;
    if (oldest === undefined) break;
    commentsCache.delete(oldest);
  }
}

/** Test-only: drop the per-thread cache so cases don't leak state into each other. */
export function __clearCommentsCacheForTests(): void {
  commentsCache.clear();
}

const itemCache = new Map<string, { at: number; data: Extract<GithubItemResponse, { available: true }> }>();

function itemCacheKey(repoRoot: string, kind: 'issue' | 'pr', number: number): string {
  return `${githubContext(repoRoot).key}\0${kind}#${number}`;
}

export function forgetGithubItem(repoRoot: string, kind: 'issue' | 'pr', number: number): void {
  itemCache.delete(itemCacheKey(repoRoot, kind, number));
}

/** Test-only: drop the single-item cache. */
export function __clearGithubItemCacheForTests(): void {
  itemCache.clear();
}

export async function fetchGithubItem(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<GithubItemResponse> {
  if (productEnv('DRY_RUN') === '1') {
    const mock = mockGithub();
    const item = (kind === 'issue' ? mock.issues : mock.prs).find((i) => i.number === number);
    return item
      ? { available: true, item, labelColors: mock.labelColors ?? {} }
      : { available: true, item: null };
  }
  const key = itemCacheKey(repoRoot, kind, number);
  const hit = itemCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const forge = await detectGithub(repoRoot);
    if (!forge.available) return { available: false, reason: forge.reason ?? 'GitHub is unavailable' };
    const labelColors: Record<string, string> = {};
    const item = await viewGithubItem(repoRoot, kind, number, labelColors);
    const data: Extract<GithubItemResponse, { available: true }> = {
      available: true, item, ...(item ? { labelColors } : {}),
    };
    itemCache.delete(key);
    itemCache.set(key, { at: Date.now(), data });
    while (itemCache.size > COMMENTS_CACHE_MAX) {
      const oldest = itemCache.keys().next().value;
      if (oldest === undefined) break;
      itemCache.delete(oldest);
    }
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
}

const itemDetailSchema = z.object({
  body: z.string().nullish(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

async function fetchItemDetail(repoRoot: string, kind: 'issue' | 'pr', number: number): Promise<ForgeCommentsData['detail']> {
  try {
    const out = await gh(repoRoot, [kind, 'view', String(number), '--json', kind === 'pr' ? 'body,additions,deletions' : 'body']);
    const parsed = itemDetailSchema.parse(JSON.parse(out));
    return {
      body: (parsed.body ?? '').slice(0, COMMENT_BODY_CAP),
      ...(kind === 'pr' && parsed.additions !== undefined ? { additions: parsed.additions } : {}),
      ...(kind === 'pr' && parsed.deletions !== undefined ? { deletions: parsed.deletions } : {}),
    };
  } catch {
    return undefined;
  }
}

const commentCountsCache = new Map<string, { at: number; count: number }>();
const commentCountsSchema = z.object({
  data: z.object({
    repository: z.record(z.string(), z.object({ comments: z.object({ totalCount: z.number().int().nonnegative() }) }).nullable()),
  }),
});

export function evictGithubCommentCaches(contextKey: string): void {
  commentCountsCache.forEach((_value, key) => {
    if (key.startsWith(`${contextKey}\0`)) commentCountsCache.delete(key);
  });
  commentsCache.forEach((_value, key) => {
    if (key.startsWith(`${contextKey}\0`)) commentsCache.delete(key);
  });
  itemCache.forEach((_value, key) => {
    if (key.startsWith(`${contextKey}\0`)) itemCache.delete(key);
  });
}

/**
 * Comment counts for the given issue or PR numbers, in one aliased GraphQL query.
 */
export async function fetchGithubCommentCounts(
  repoRoot: string, kind: 'issue' | 'pr', numbers: number[], refresh = false,
): Promise<GithubCommentCountsData> {
  if (productEnv('DRY_RUN') === '1') return mockGithubCommentCounts(kind, numbers);
  const context = githubContext(repoRoot);
  const wanted = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, GITHUB_COMMENT_COUNTS_MAX);
  const counts: Record<number, number> = {};
  const misses: number[] = [];
  const now = Date.now();
  const keyOf = (n: number) => `${context.key}\0${kind}\0${n}`;
  for (const n of wanted) {
    const hit = commentCountsCache.get(keyOf(n));
    if (!refresh && hit && now - hit.at < CACHE_MS) counts[n] = hit.count;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, counts };
  try {
    const handle = await resolveRepoHandleStrict(repoRoot, context);
    if (!handle) return { available: false, reason: 'Could not resolve this repository on GitHub.' };
    const fields = misses.map((n) => `n${n}: issueOrPullRequest(number: ${n}) {
      ... on Issue { comments { totalCount } }
      ... on PullRequest { comments { totalCount } }
    }`).join('\n');
    const raw = await refStatusGraphql(repoRoot, context)(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: handle.owner, name: handle.name },
    );
    const rows = commentCountsSchema.parse(JSON.parse(raw)).data.repository;
    for (const n of misses) {
      const count = rows[`n${n}`]?.comments.totalCount;
      if (count === undefined) continue;
      counts[n] = count;
      commentCountsCache.delete(keyOf(n));
      commentCountsCache.set(keyOf(n), { at: now, count });
    }
    while (commentCountsCache.size > CHECKS_CACHE_MAX) {
      const oldest = commentCountsCache.keys().next().value;
      if (oldest === undefined) break;
      commentCountsCache.delete(oldest);
    }
    return { available: true, counts };
  } catch (err) {
    return { available: false, reason: ghFailureReason(err) };
  }
}

function mockGithubCommentCounts(kind: 'issue' | 'pr', numbers: number[]): GithubCommentCountsData {
  const rows = kind === 'pr' ? mockGithub().prs : mockGithub().issues;
  const counts: Record<number, number> = {};
  for (const n of numbers) {
    const row = rows.find((item) => item.number === n);
    if (row) counts[n] = row.comments;
  }
  return { available: true, counts };
}

function commentsCacheKey(repoRoot: string, kind: 'issue' | 'pr', number: number): string {
  return `${githubContext(repoRoot).key}\0${kind}#${number}`;
}

function cachedGithubComments(key: string, refresh: boolean): ForgeCommentsData | undefined {
  const hit = commentsCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  return undefined;
}

function legacyIssueComments(repoRoot: string, number: number): () => Promise<string> {
  return () => gh(repoRoot, ['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate']);
}

function parseUnknownRows(raw: string): unknown[] {
  return z.array(z.unknown()).parse(JSON.parse(raw));
}

function commentedTimelineRows(rows: unknown[]): unknown[] {
  return rows.filter((row) => (row as { event?: unknown } | null)?.event === 'commented');
}

async function fetchIssueTimelinePages(repoRoot: string, number: number): Promise<TimelinePages> {
  return fetchTimelinePages((page, timeoutMs) =>
    gh(
      repoRoot,
      [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/issues/${number}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`,
      ],
      timeoutMs,
    ),
  );
}

async function topUpTimelineComments(
  commentRows: unknown[],
  stoppedShort: boolean,
  legacyComments: () => Promise<string>,
): Promise<unknown[]> {
  if (!(stoppedShort && commentRows.length < THREAD_ENTRY_CAP)) return commentRows;
  try {
    return parseUnknownRows(await legacyComments());
  } catch {
    return commentRows;
  }
}

type GithubThreadSource = {
  commentRows: unknown[];
  events: ForgeTimelineEvent[] | undefined;
  eventsTruncated: boolean;
  stoppedShort: boolean;
};

async function loadGithubThreadSource(
  repoRoot: string,
  number: number,
  legacyComments: () => Promise<string>,
): Promise<GithubThreadSource> {
  const source: GithubThreadSource = {
    commentRows: [],
    events: undefined,
    eventsTruncated: false,
    stoppedShort: false,
  };
  try {
    const pages = await fetchIssueTimelinePages(repoRoot, number);
    source.stoppedShort = pages.stoppedShort;
    source.commentRows = commentedTimelineRows(pages.rows);
    const normalized = normalizeEvents(pages.rows);
    source.events = normalized.events;
    source.eventsTruncated = normalized.truncated;
    source.commentRows = await topUpTimelineComments(
      source.commentRows,
      source.stoppedShort,
      legacyComments,
    );
    return source;
  } catch (timelineErr) {
    const message = timelineErr instanceof Error ? timelineErr.message : String(timelineErr);
    if (/ENOENT/.test(message)) throw timelineErr;
    source.commentRows = parseUnknownRows(await legacyComments());
    source.events = undefined;
    return source;
  }
}

function applyCommitChecks(
  events: ForgeTimelineEvent[],
  checks: Awaited<ReturnType<typeof fetchCommitChecks>>,
): void {
  for (const event of events) {
    if (event.kind !== 'committed' || !event.sha) continue;
    if (event.sha in checks) {
      delete event.checks;
      Object.assign(event, defined({ checks: checks[event.sha] }));
    }
  }
}

async function attachCommitChecks(repoRoot: string, events: ForgeTimelineEvent[] | undefined): Promise<void> {
  const commitShas = (events ?? []).flatMap((event) => (event.kind === 'committed' && event.sha ? [event.sha] : []));
  if (commitShas.length === 0) return;
  const handle = await resolveRepoHandle(repoRoot);
  if (!handle) return;
  const runGraphql: GraphqlRunner = (query, variables) => {
    const args = ghGraphqlArgs(query, variables);
    return gh(repoRoot, args);
  };
  applyCommitChecks(events ?? [], await fetchCommitChecks(runGraphql, handle.owner, handle.name, commitShas));
}

async function mergeGithubThread(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  commentRows: unknown[],
): Promise<{ comments: ForgeComment[]; truncated: boolean }> {
  const parts: ForgeComment[][] = [normalizeComments(commentRows)];
  if (kind === 'pr') {
    const reviewsOut = await gh(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--paginate']);
    parts.push(normalizeReviews(JSON.parse(reviewsOut)));
  }
  return mergeThread(parts);
}

function commentsFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(message)) return 'gh CLI not found — install it and run `gh auth login`';
  if (/404|not found/i.test(message)) return 'not found on GitHub — it may be closed or deleted';
  return firstLine(message);
}

async function loadGithubComments(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  key: string,
): Promise<ForgeCommentsData> {
  const legacyComments = legacyIssueComments(repoRoot, number);
  const detail = fetchItemDetail(repoRoot, kind, number);
  try {
    const source = await loadGithubThreadSource(repoRoot, number, legacyComments);
    await attachCommitChecks(repoRoot, source.events);
    const { comments, truncated } = await mergeGithubThread(repoRoot, kind, number, source.commentRows);
    const data: ForgeCommentsData = defined({
      available: true as const,
      comments,
      truncated: truncated || source.eventsTruncated || source.stoppedShort || undefined,
    });
    if (source.events) data.events = source.events;
    const itemDetail = await detail;
    if (itemDetail) data.detail = itemDetail;
    cacheComments(key, data);
    return data;
  } catch (err) {
    return { available: false, reason: commentsFailureReason(err), comments: [] };
  }
}

export async function fetchGithubComments(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<ForgeCommentsData> {
  if (productEnv('DRY_RUN') === '1') return mockGithubComments(kind, number);
  const key = commentsCacheKey(repoRoot, kind, number);
  const cached = cachedGithubComments(key, refresh);
  if (cached) return cached;
  return loadGithubComments(repoRoot, kind, number, key);
}

function mockGithubComments(kind: 'issue' | 'pr', number?: number): ForgeCommentsData {
  const base = Date.now() - 3_600_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  const comments: ForgeComment[] = [
    {
      id: 1,
      author: 'ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      createdAt: at(0),
      body: 'Thanks for the report — I can reproduce. Which browser were you on?\n\n```\nchrome 126, macOS\n```',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-1',
    },
    {
      id: 2,
      author: 'lin',
      createdAt: at(600_000),
      body: 'Here is the failing screen:\n\n![failure](https://avatars.githubusercontent.com/u/2?v=4)',
      kind: 'comment',
      url: 'https://github.com/mock/repo/issues/1#issuecomment-2',
    },
  ];
  if (kind === 'pr') {
    comments.push({
      id: 3,
      author: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_200_000),
      body: 'Looks good overall — please add a regression test before this lands.',
      kind: 'review',
      reviewState: 'changes_requested',
      url: 'https://github.com/mock/repo/pull/1#pullrequestreview-3',
    });
  }

  const sha = (seed: string) => seed.repeat(40).slice(0, 40);
  const events: ForgeTimelineEvent[] = [
    {
      id: 'evt-100',
      kind: 'labeled',
      actor: 'ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      createdAt: at(300_000),
      label: { name: 'bug', color: 'd73a4a' },
    },
    {
      id: `evt-${sha('a')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(900_000),
      sha: sha('a'),
      message: 'fix(session): keep the refresh token on reload',
      checks: 'passing',
    },
    {
      id: `evt-${sha('b')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(960_000),
      sha: sha('b'),
      message: 'test(session): cover the reload path',
      checks: 'failing',
    },
    {
      id: `evt-${sha('c')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(1_020_000),
      sha: sha('c'),
      message: 'chore: appease the linter',
      checks: 'pending',
    },
    {
      id: `evt-${sha('d')}`,
      kind: 'committed',
      actor: 'Lin Zhao',
      createdAt: at(1_080_000),
      sha: sha('d'),
      message: 'docs: note the new behavior',
      checks: null,
    },
    {
      id: 'evt-101',
      kind: 'cross-referenced',
      actor: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_500_000),
      refNumber: 42,
      refTitle: 'Session handling rewrite',
      refIsPr: true,
      url: 'https://github.com/mock/repo/pull/42',
    },
  ];
  if (kind === 'pr') {
    events.push({
      id: 'evt-102',
      kind: 'merged',
      actor: 'grace',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      createdAt: at(1_800_000),
    });
  }

  const row = number === undefined ? undefined
    : (kind === 'pr' ? mockGithub().prs : mockGithub().issues).find((item) => item.number === number);
  const detail = row ? {
    body: row.body ?? '',
    ...(kind === 'pr' ? { additions: row.additions ?? 0, deletions: row.deletions ?? 0 } : {}),
  } : undefined;
  return { available: true, comments, events, ...(detail ? { detail } : {}) };
}
