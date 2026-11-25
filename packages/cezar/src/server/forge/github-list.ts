import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GITHUB_SEARCH_MAX, type GithubProject, type GithubProjectsData } from '@open-mercato/cezar-contract/github';
import { productEnv } from '../../core/product-env.ts';
import { mergedPullRequestObservations } from '../../merge-observations.ts';
import { gh, githubContext, parseOwnerName, type GithubContext } from './github-cli.ts';
import { forgettingNameOnMiss, resolveRepoHandle } from './github-repo-handle.ts';
import { fetchIssueProjects, fetchRepositoryProjects, fetchViewerLogin } from './github-filters.ts';
import {
  CACHE_MS,
  firstLine,
  ghAuthor,
  ghFailureReason,
  ghGraphqlArgs,
  ghIssueSchema,
  ghLabel,
  mockGithub,
  resolveRepoHandleStrict,
  type GithubData,
  type GithubItem,
  type GraphqlRunner,
} from './github-shared.ts';
import type { ForgeItem, ForgeListOptions, ForgeSearchData } from './types.ts';

/** GitHub GraphQL rejects `first` above 100 (EXCESSIVE_PAGINATION); larger limits walk pages. */
export const GH_GRAPHQL_PAGE_MAX = 100;

export type ListSide = 'issues' | 'pullRequests';

// Labels up to 100, which is what `gh issue list --json labels` read before the GraphQL page.
const LIST_NODE_FIELDS = 'number title author { login } createdAt url body labels(first: 100) { nodes { name color } }';
const listQuery = (side: ListSide): string => `
query ($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    ${side}(first: $first, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_NODE_FIELDS} ${side === 'issues' ? 'assignees(first: 20) { nodes { login } }' : 'isDraft additions deletions'} }
    }
  }
}`;

/** A GraphQL connection (`{ nodes }`) read as the flat array `gh … --json` used to return. */
const connectionOf = <T extends z.ZodType>(item: T) =>
  z.object({ nodes: z.array(item.nullable()).default([]) }).nullish()
    .transform((connection) => (connection?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node != null));

const ghListNodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  url: z.string(),
  body: z.string().nullish(),
  labels: connectionOf(ghLabel),
  assignees: connectionOf(z.object({ login: z.string() })),
  isDraft: z.boolean().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
});
export type ListNode = z.infer<typeof ghListNodeSchema>;

const ghListConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  nodes: z.array(ghListNodeSchema.nullable()),
});

function parseListConnection(out: string, side: ListSide): z.infer<typeof ghListConnectionSchema> {
  const parsed = JSON.parse(out) as { data?: { repository?: Record<string, unknown> | null }; errors?: Array<{ message?: string }> };
  const message = parsed.errors?.map((e) => e.message).filter(Boolean).join(' ');
  if (message) throw new Error(message);
  if (!parsed.data?.repository) throw new Error('GitHub did not resolve this repository');
  return ghListConnectionSchema.parse(parsed.data.repository[side]);
}

/**
 * One side of the open list: up to `limit` rows from `cursor`, in requests of at most
 * `GH_GRAPHQL_PAGE_MAX`. `nextCursor` is where the rows stop, or `null` once the side is
 * exhausted. `done` asks for `first: 0`, which still answers `totalCount`, so an exhausted side
 * keeps a fresh total without ever restarting from its first page.
 */
export async function fetchListConnection(
  run: GraphqlRunner,
  owner: string,
  name: string,
  side: ListSide,
  limit: number,
  cursor?: string,
  done = false,
): Promise<{ totalCount: number; nodes: ListNode[]; nextCursor: string | null }> {
  const query = listQuery(side);
  if (done) {
    const page = parseListConnection(await run(query, { owner, name, first: 0 }), side);
    return { totalCount: page.totalCount, nodes: [], nextCursor: null };
  }
  const nodes: ListNode[] = [];
  let after = cursor;
  for (;;) {
    const first = Math.min(GH_GRAPHQL_PAGE_MAX, limit - nodes.length);
    const page = parseListConnection(await run(query, { owner, name, first, ...(after ? { after } : {}) }), side);
    const rows = page.nodes.filter((node): node is ListNode => node !== null);
    nodes.push(...rows);
    const next = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? null : null;
    // An empty page that claims more would loop forever; read it as the end of the side.
    if (next === null || rows.length === 0) return { totalCount: page.totalCount, nodes, nextCursor: null };
    if (next === after) throw new Error('GitHub list cursor did not advance');
    // A short page with more behind it still ends this request: the cursor resumes it exactly.
    if (nodes.length >= limit || rows.length < first) return { totalCount: page.totalCount, nodes, nextCursor: next };
    after = next;
  }
}

let listRequestOrder = 0;
const listRefreshOrder = new Map<string, number>();
const listCache = new Map<string, {
  contextKey: string; order: number; at: number; limit: number; data: GithubData; projects: Promise<GithubProjectsData>;
}>();
const LIST_CACHE_MAX = 50;
const projectGenerations = new Map<string, string>();
const repositoryProjectsCache = new Map<string, { at: number; projects: Promise<GithubProject[]> }>();

function dropListEntry(key: string): void {
  const generation = listCache.get(key)?.data.projectsGeneration;
  if (generation && projectGenerations.get(generation) === key) projectGenerations.delete(generation);
  listCache.delete(key);
}

export function evictGithubListCaches(contextKey: string): void {
  listCache.forEach((entry, key) => {
    if (entry.contextKey === contextKey) dropListEntry(key);
  });
  repositoryProjectsCache.delete(contextKey);
}

function discoverRepositoryProjects(contextKey: string, refresh: boolean, start: () => Promise<GithubProject[]>): Promise<GithubProject[]> {
  const hit = repositoryProjectsCache.get(contextKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.projects;
  const projects = start();
  const entry = { at: Date.now(), projects };
  repositoryProjectsCache.delete(contextKey);
  repositoryProjectsCache.set(contextKey, entry);
  projects.catch(() => {
    if (repositoryProjectsCache.get(contextKey) === entry) repositoryProjectsCache.delete(contextKey);
  });
  while (repositoryProjectsCache.size > LIST_CACHE_MAX) {
    const oldest = repositoryProjectsCache.keys().next().value;
    if (oldest === undefined) break;
    repositoryProjectsCache.delete(oldest);
  }
  return projects;
}

export const GH_MAX_LIMIT = 1000;

/** Where one list page starts on each side. A done side answered `nextCursor: null` already. */
export type GithubPageRequest = Pick<ForgeListOptions, 'issuesCursor' | 'prsCursor' | 'issuesDone' | 'prsDone'>;

function listPageKey(contextKey: string, page: GithubPageRequest): string {
  return JSON.stringify([contextKey, page.issuesCursor ?? null, page.prsCursor ?? null, !!page.issuesDone, !!page.prsDone]);
}

type ListCacheHit = NonNullable<ReturnType<typeof listCache.get>>;

function isFirstGithubPage(page: GithubPageRequest): boolean {
  return !page.issuesCursor && !page.prsCursor && !page.issuesDone && !page.prsDone;
}

function cachedGithubPage(hit: ListCacheHit | undefined, refresh: boolean, capped: number): GithubData | undefined {
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS && hit.limit >= capped) return hit.data;
  return undefined;
}

function rememberListRefresh(contextKey: string, order: number, key: string): void {
  listRefreshOrder.delete(contextKey);
  listRefreshOrder.set(contextKey, order);
  while (listRefreshOrder.size > LIST_CACHE_MAX) {
    const oldest = listRefreshOrder.keys().next().value;
    if (oldest === undefined) break;
    listRefreshOrder.delete(oldest);
  }
  for (const [cached, entry] of [...listCache]) {
    if (entry.contextKey === contextKey && cached !== key) dropListEntry(cached);
  }
}

function githubProjectGraphql(repoRoot: string, context: GithubContext): GraphqlRunner {
  const deadline = Date.now() + 15_000;
  return (query, variables) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Project lookup timed out'));
    return gh(repoRoot, ghGraphqlArgs(query, variables), Math.min(remaining, 8_000), undefined, context);
  };
}

function recordLabelColor(labelColors: Record<string, string>, label: { name: string; color: string }): void {
  if (label.color && !labelColors[label.name]) labelColors[label.name] = label.color;
}

function flattenGithubIssue(issue: ListNode, recordColor: (label: { name: string; color: string }) => void): GithubItem {
  issue.labels.forEach(recordColor);
  return {
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    author: issue.author?.login ?? '?',
    createdAt: issue.createdAt,
    labels: issue.labels.map((label) => label.name),
    body: (issue.body ?? '').slice(0, 8_000),
    url: issue.url,
    comments: 0,
    assignees: issue.assignees.map((assignee) => assignee.login),
  };
}

function flattenGithubPr(pr: ListNode, recordColor: (label: { name: string; color: string }) => void): GithubItem {
  pr.labels.forEach(recordColor);
  const isDraft = pr.isDraft ?? false;
  return {
    kind: 'pr',
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? '?',
    createdAt: pr.createdAt,
    labels: [...pr.labels.map((label) => label.name), ...(isDraft ? ['draft'] : [])],
    body: (pr.body ?? '').slice(0, 8_000),
    url: pr.url,
    comments: 0,
    isDraft,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    checks: null,
  };
}

function applyPreviousProjectIds(issues: GithubItem[], previous: GithubData | undefined): void {
  for (const issue of issues) {
    const known = previous?.issues.find((row) => row.number === issue.number)?.projectIds;
    if (known !== undefined) issue.projectIds = known;
  }
}

function githubListData(input: {
  repo: string;
  issues: GithubItem[];
  prs: GithubItem[];
  labelColors: Record<string, string>;
  viewerLogin: string | undefined;
  generation: string;
  previous: GithubData | undefined;
  issuesTotal: number;
  prsTotal: number;
  issuesNextCursor: string | null;
  prsNextCursor: string | null;
}): GithubData {
  return {
    available: true,
    repo: input.repo,
    syncedAt: new Date().toISOString(),
    issues: input.issues,
    prs: input.prs,
    labelColors: input.labelColors,
    ...(input.viewerLogin ? { viewerLogin: input.viewerLogin } : {}),
    projectsState: 'refreshing',
    projectsGeneration: input.generation,
    ...(input.previous?.projects ? { projects: input.previous.projects } : {}),
    issuesTotal: input.issuesTotal,
    prsTotal: input.prsTotal,
    issuesNextCursor: input.issuesNextCursor,
    prsNextCursor: input.prsNextCursor,
    commentsDeferred: true,
  };
}

function applyReadyProjectMembership(current: ListCacheHit, metadata: Extract<GithubProjectsData, { state: 'ready' }>): void {
  current.data = {
    ...current.data,
    projectsState: metadata.state,
    projects: metadata.projects,
    issues: current.data.issues.map((issue) => ({ ...issue, projectIds: metadata.membership?.[issue.number] ?? [] })),
  };
}

function attachProjectMetadata(
  projectLookup: ReturnType<typeof fetchIssueProjects>,
  generation: string,
  key: string,
): Promise<GithubProjectsData> {
  return projectLookup.then((result): GithubProjectsData => {
    const metadata: GithubProjectsData = 'membership' in result
      ? { generation, state: 'ready', projects: result.projects, membership: result.membership }
      : { generation, state: 'unavailable', reason: result.projectsReason };
    const current = listCache.get(key);
    if (current?.data.projectsGeneration === generation) {
      if (metadata.state === 'ready') applyReadyProjectMembership(current, metadata);
      else current.data = { ...current.data, projectsState: metadata.state, projectsReason: metadata.reason };
    }
    return metadata;
  });
}

function storeGithubPage(
  key: string,
  contextKey: string,
  order: number,
  capped: number,
  data: GithubData,
  projects: Promise<GithubProjectsData>,
  generation: string,
): void {
  if ((listCache.get(key)?.order ?? -1) < order && order >= (listRefreshOrder.get(contextKey) ?? 0)) {
    dropListEntry(key);
    listCache.set(key, { contextKey, order, at: Date.now(), limit: capped, data, projects });
    projectGenerations.set(generation, key);
  }
  while (listCache.size > LIST_CACHE_MAX) {
    const oldest = listCache.keys().next().value;
    if (oldest === undefined) break;
    dropListEntry(oldest);
  }
}

async function loadGithubPage(
  repoRoot: string,
  context: GithubContext,
  capped: number,
  page: GithubPageRequest,
  key: string,
  hit: ListCacheHit | undefined,
  order: number,
  refresh: boolean,
): Promise<GithubData> {
  const timeout = capped > 100 ? 30_000 : 15_000;
  const ownerName = await resolveRepoHandleStrict(repoRoot, context);
  if (!ownerName) return { available: false, reason: 'Could not resolve this repository on GitHub.', issues: [], prs: [] };
  const runGraphql: GraphqlRunner = (query, variables) =>
    forgettingNameOnMiss(repoRoot, () => gh(repoRoot, ghGraphqlArgs(query, variables), timeout, undefined, context));
  const projectGraphql = githubProjectGraphql(repoRoot, context);
  const firstPage = isFirstGithubPage(page);
  const issueSide = fetchListConnection(runGraphql, ownerName.owner, ownerName.name, 'issues', capped, page.issuesCursor, page.issuesDone);
  const projectLookup = fetchIssueProjects(projectGraphql, ownerName.owner, ownerName.name,
    async () => (await issueSide).nodes.map((node) => node.number),
    () => discoverRepositoryProjects(context.key, refresh,
      () => fetchRepositoryProjects(projectGraphql, ownerName.owner, ownerName.name)));
  const [issuesPage, prsPage, viewerLogin] = await Promise.all([
    issueSide,
    fetchListConnection(runGraphql, ownerName.owner, ownerName.name, 'pullRequests', capped, page.prsCursor, page.prsDone),
    firstPage
      ? fetchViewerLogin((query) => gh(repoRoot, ghGraphqlArgs(query), 8_000, undefined, context))
      : Promise.resolve(undefined),
  ]);
  const labelColors: Record<string, string> = {};
  const recordColor = (label: { name: string; color: string }) => recordLabelColor(labelColors, label);
  const issues = issuesPage.nodes.map((issue) => flattenGithubIssue(issue, recordColor));
  const prs = prsPage.nodes.map((pr) => flattenGithubPr(pr, recordColor));
  const previous = hit?.data.repo === `${ownerName.owner}/${ownerName.name}` ? hit.data : undefined;
  applyPreviousProjectIds(issues, previous);
  const generation = randomUUID();
  const data = githubListData({
    repo: `${ownerName.owner}/${ownerName.name}`,
    issues,
    prs,
    labelColors,
    viewerLogin,
    generation,
    previous,
    issuesTotal: issuesPage.totalCount,
    prsTotal: prsPage.totalCount,
    issuesNextCursor: issuesPage.nextCursor,
    prsNextCursor: prsPage.nextCursor,
  });
  const projects = attachProjectMetadata(projectLookup, generation, key);
  storeGithubPage(key, context.key, order, capped, data, projects, generation);
  return data;
}

export async function fetchGithub(repoRoot: string, refresh = false, limit = 30, page: GithubPageRequest = {}): Promise<GithubData> {
  if (productEnv('DRY_RUN') === '1') return mockGithubPage(limit, page);
  const context = githubContext(repoRoot);
  const capped = Math.min(Math.max(limit, 1), GH_MAX_LIMIT);
  const key = listPageKey(context.key, page);
  const hit = listCache.get(key);
  const cached = cachedGithubPage(hit, refresh, capped);
  if (cached) return cached;
  const order = ++listRequestOrder;
  if (refresh && isFirstGithubPage(page)) rememberListRefresh(context.key, order, key);
  try {
    return await loadGithubPage(repoRoot, context, capped, page, key, hit, order, refresh);
  } catch (err) {
    return { available: false, reason: ghFailureReason(err), issues: [], prs: [] };
  }
}

/** Bounded lookup already started by the list. Never launch work for an expired generation. */
export async function fetchGithubProjects(repoRoot: string, generation: string): Promise<GithubProjectsData> {
  const key = projectGenerations.get(generation);
  const entry = key === undefined ? undefined : listCache.get(key);
  if (!entry || entry.contextKey !== githubContext(repoRoot).key || entry.data.projectsGeneration !== generation) {
    return { generation, state: 'unavailable', reason: 'Project metadata expired. Refresh to try again.' };
  }
  return entry.projects;
}

/** Hits per search. */
export const GH_SEARCH_MAX = GITHUB_SEARCH_MAX;

const SEARCH_FIELDS = 'number,title,author,createdAt,labels,body,url';

function searchJsonFields(kind: 'issue' | 'pr'): string {
  return kind === 'pr'
    ? `${SEARCH_FIELDS},isDraft,commentsCount`
    : `${SEARCH_FIELDS},assignees,commentsCount`;
}

const ghSearchHitSchema = ghIssueSchema.extend({
  assignees: z.array(z.object({ login: z.string() })).optional(),
  isDraft: z.boolean().default(false),
  commentsCount: z.number().default(0),
});

const ghViewHitSchema = ghIssueSchema.extend({
  state: z.string().optional(),
  mergedAt: z.unknown().optional(),
  assignees: z.array(z.object({ login: z.string() })).optional(),
  isDraft: z.boolean().default(false),
  additions: z.number().default(0),
  deletions: z.number().default(0),
});

function toSearchItem(
  kind: 'issue' | 'pr',
  hit: (z.infer<typeof ghSearchHitSchema> | z.infer<typeof ghViewHitSchema>) & { commentsCount: number },
  labelColors: Record<string, string>,
): ForgeItem {
  for (const label of hit.labels) {
    if (label.color && !labelColors[label.name]) labelColors[label.name] = label.color;
  }
  const item: ForgeItem = {
    kind,
    number: hit.number,
    title: hit.title,
    author: hit.author?.login ?? '?',
    createdAt: hit.createdAt,
    labels: hit.labels.map((l) => l.name),
    body: (hit.body ?? '').slice(0, 8_000),
    url: hit.url,
    comments: hit.commentsCount,
    ...(kind === 'issue' && hit.assignees ? { assignees: hit.assignees.map(a => a.login) } : {}),
  };
  if (kind === 'pr') {
    item.isDraft = hit.isDraft;
    if (hit.isDraft) item.labels = [...item.labels, 'draft'];
    if ('additions' in hit) item.additions = hit.additions;
    if ('deletions' in hit) item.deletions = hit.deletions;
    item.checks = null;
  }
  return item;
}

const MISSING_ITEM_RE =
  /could not resolve to an? (?:pullrequest|issue|issueorpullrequest|pull request|issue or pull request)\b|no (?:pull requests|issues) found/i;

async function viewGithubHit(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
): Promise<z.infer<typeof ghViewHitSchema> | null> {
  try {
    const out = await gh(repoRoot, [
      kind === 'pr' ? 'pr' : 'issue',
      'view',
      String(number),
      '--json',
      kind === 'pr' ? `${SEARCH_FIELDS},isDraft,additions,deletions,state,mergedAt` : `${SEARCH_FIELDS},assignees`,
    ]);
    const hit = ghViewHitSchema.parse(JSON.parse(out));
    if (kind === 'pr' && hit.state === 'MERGED') {
      const handle = await resolveRepoHandle(repoRoot);
      if (handle) mergedPullRequestObservations.observe({ owner: handle.owner, repo: handle.name, number }, hit);
    }
    return hit;
  } catch (err) {
    if (MISSING_ITEM_RE.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

async function finishViewHit(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  hit: z.infer<typeof ghViewHitSchema>,
  labelColors: Record<string, string>,
): Promise<ForgeItem> {
  const commentsCount = z.number().int().nonnegative().parse(JSON.parse(await gh(repoRoot,
    ['api', `repos/{owner}/{repo}/issues/${number}`, '--jq', '.comments'], 8_000)));
  return toSearchItem(kind, { ...hit, commentsCount }, labelColors);
}

/**
 * One issue or PR by number, in any state (#692). `null` when `gh` confirms the item is absent;
 * throws on every other failure. `labelColors` is an optional out-param.
 */
export async function viewGithubItem(
  repoRoot: string,
  kind: 'issue' | 'pr',
  number: number,
  labelColors: Record<string, string> = {},
): Promise<ForgeItem | null> {
  const hit = await viewGithubHit(repoRoot, kind, number);
  return hit ? finishViewHit(repoRoot, kind, number, hit, labelColors) : null;
}

/**
 * Search any state: exact numbers try a direct lookup, then text fallback; text search omits
 * state restriction. Return availability and a reason on failure instead of throwing.
 */
export async function searchGithubItems(
  repoRoot: string,
  kind: 'issue' | 'pr',
  query: string,
  limit = GH_SEARCH_MAX,
): Promise<ForgeSearchData> {
  const trimmed = query.trim();
  if (trimmed === '') return { available: true, items: [] };
  const capped = Math.min(Math.max(limit, 1), GH_SEARCH_MAX);
  if (productEnv('DRY_RUN') === '1') {
    const mock = mockGithub();
    const pool = kind === 'issue' ? mock.issues : mock.prs;
    const queryText = trimmed.toLowerCase();
    const numeric = queryText.replace(/^#/, '');
    const idOnly = /^\d+$/.test(numeric);
    const items = pool
      .filter((item) => idOnly
        ? String(item.number).includes(numeric)
        : `#${item.number} ${item.title} ${item.author} ${item.body}`.toLowerCase().includes(queryText))
      .slice(0, capped)
      .map(item => item.kind === 'pr' ? { ...item, checks: null } : item);
    return { available: true, items, truncated: items.length >= capped };
  }
  const labelColors: Record<string, string> = {};
  const numeric = trimmed.replace(/^#/, '');
  try {
    if (/^\d+$/.test(numeric)) {
      const number = Number(numeric);
      let hit: z.infer<typeof ghViewHitSchema> | null = null;
      try {
        hit = await viewGithubHit(repoRoot, kind, number);
      } catch {
        // fall through
      }
      if (hit) {
        const item = await finishViewHit(repoRoot, kind, number, hit, labelColors);
        return await hydrateSearchProjects(repoRoot, kind, { available: true, items: [item], labelColors });
      }
    }
    const handle =
      (await resolveRepoHandle(repoRoot)) ??
      parseOwnerName(
        await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
      );
    if (!handle) {
      return { available: false, reason: 'no GitHub remote to search', items: [] };
    }
    const out = await forgettingNameOnMiss(repoRoot, () => gh(repoRoot, [
      'search',
      kind === 'pr' ? 'prs' : 'issues',
      '--repo',
      `${handle.owner}/${handle.name}`,
      '--limit',
      String(capped),
      '--json',
      searchJsonFields(kind),
      '--',
      trimmed,
    ]));
    const hits = z.array(ghSearchHitSchema).parse(JSON.parse(out));
    const prefix = `/${handle.owner}/${handle.name}/${kind === 'pr' ? 'pull' : 'issues'}/`.toLowerCase();
    if (hits.some(hit => {
      try { return new URL(hit.url).pathname.toLowerCase() !== `${prefix}${hit.number}`; }
      catch { return true; }
    })) return { available: false, reason: 'GitHub returned results outside this repository. Remove repository qualifiers and try again.', items: [] };
    return await hydrateSearchProjects(repoRoot, kind, {
      available: true,
      items: hits.map((hit) => toSearchItem(kind, hit, labelColors)),
      truncated: hits.length >= capped,
      labelColors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /ENOENT/.test(message)
      ? 'gh CLI not found — install it and run `gh auth login`'
      : firstLine(message);
    return { available: false, reason, items: [] };
  }
}

async function hydrateSearchProjects(
  repoRoot: string, kind: 'issue' | 'pr', data: ForgeSearchData,
): Promise<ForgeSearchData> {
  if (kind !== 'issue' || data.items.length === 0) return data;
  const handle = await resolveRepoHandle(repoRoot);
  if (!handle) return { ...data, projectsReason: 'Project boards unavailable for this repository.' };
  const deadline = Date.now() + 15_000;
  const run: GraphqlRunner = (query, variables) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Project lookup timed out'));
    const args = ghGraphqlArgs(query, variables);
    return gh(repoRoot, args, Math.min(remaining, 8_000));
  };
  const projects = await fetchIssueProjects(run, handle.owner, handle.name, data.items.map(item => item.number));
  if ('projectsReason' in projects) return { ...data, projectsReason: projects.projectsReason };
  return { ...data, items: data.items.map(item => ({ ...item, projectIds: projects.membership[item.number] ?? [] })) };
}

function mockGithubPage(limit: number, page: GithubPageRequest): GithubData {
  const full = mockGithub();
  const side = (rows: GithubItem[], cursor: string | undefined, done: boolean | undefined) => {
    const start = done ? rows.length : Number(cursor ?? 0);
    const slice = rows.slice(start, start + Math.max(limit, 1));
    const end = start + slice.length;
    return { rows: slice.map((row) => ({ ...row, comments: 0 })), next: end < rows.length ? String(end) : null };
  };
  const issues = side(full.issues, page.issuesCursor, page.issuesDone);
  const prs = side(full.prs, page.prsCursor, page.prsDone);
  const firstPage = !page.issuesCursor && !page.prsCursor && !page.issuesDone && !page.prsDone;
  const { viewerLogin, ...rest } = full;
  return {
    ...rest,
    ...(firstPage && viewerLogin ? { viewerLogin } : {}),
    issues: issues.rows,
    prs: prs.rows,
    issuesTotal: full.issues.length,
    prsTotal: full.prs.length,
    issuesNextCursor: issues.next,
    prsNextCursor: prs.next,
    commentsDeferred: true,
  };
}
