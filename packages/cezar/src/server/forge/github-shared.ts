import { productEnv } from '../../core/product-env.ts';
import { z } from 'zod';
import { gh, githubContext, type GithubContext } from './github-cli.ts';
import { sharedRepoHandle } from './github-repo-handle.ts';
import type { ForgeAvailability, ForgeItem } from './types.ts';

/** Short cache TTL shared across GitHub list, diff, comment, check, and ref-status reads. */
export const CACHE_MS = 60_000;

/** One GitHub issue or pull request, flattened for the cockpit's GitHub tab. */
export type GithubItem = ForgeItem;

export type GithubData = import('@open-mercato/cezar-contract').GithubData;

/** owner/repo parsed out of the origin remote — feeds `viewUrl`. Reads that name the repository
 *  use `canonicalRepoRef` instead, which follows a rename. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

// `gh … --json` output — validated at the boundary, extras stripped.
export const ghAuthor = z.object({ login: z.string() }).nullish();
// `color` is the 6-hex GitHub label color (no `#`), '' when gh omits it.
export const ghLabel = z.object({ name: z.string(), color: z.string().default('') });
export const ghIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: ghAuthor,
  createdAt: z.string(),
  labels: z.array(ghLabel).default([]),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  body: z.string().nullish(),
  url: z.string(),
});

// One check run's `gh --json statusCheckRollup` entry — every field optional/nullish because
// gh's shape varies by check provider (exported so #400's unit tests can build fixtures).
export const ghCheckRunSchema = z.object({
  state: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
});
export const ghStatusCheckRollup = z.array(ghCheckRunSchema).nullish();

export const ghPrViewSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string().default('OPEN'),
  mergedAt: z.unknown().optional(),
  isDraft: z.boolean().default(false),
  statusCheckRollup: ghStatusCheckRollup,
});

export const ghMergeResultSchema = z.object({
  merged: z.boolean(),
  message: z.string().nullish(),
  sha: z.string().nullish(),
});

/** Exported for unit tests (#400) — collapses a zod-validated `statusCheckRollup` array down to
 *  the single enum the GitHub tab (list rows + detail badge) renders. */
export function rollupToChecks(rollup: z.infer<typeof ghStatusCheckRollup>): GithubItem['checks'] {
  if (!rollup || rollup.length === 0) return null;
  const states = rollup.map((r) => (r.conclusion || r.state || r.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'failing';
  if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

/** Runs a GraphQL query — injected so pagination is unit-testable without shelling to `gh`.
 *  Number variables reach GitHub typed (`-F`), strings raw (`-f`): see `ghGraphqlArgs`. */
export type GraphqlRunner = (query: string, variables: Record<string, string | number>) => Promise<string>;

/** `gh api graphql` argv. `-f` sends every value as a String, and GitHub rejects a String where
 *  the query declares `Int!` ("Could not coerce value to Int", open-mercato/cezar#1366), so a
 *  number goes through `-F`. A string never does: `-F` would read `@file` and coerce
 *  `true`/numerals, which is not what an opaque cursor or a login means. */
export function ghGraphqlArgs(query: string, variables: Record<string, string | number> = {}): string[] {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return args;
}

/** A `gh` failure as one readable line. GitHub's own words come on stderr; the Node message
 *  starts with the whole argv, and a GraphQL argv is a multi-line query, so its first line is
 *  a fragment of that query rather than the reason (open-mercato/cezar#1366). */
export function ghFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(message)) return 'gh CLI not found — install it and run `gh auth login`';
  const failure = (err ?? {}) as { stderr?: unknown; killed?: unknown; signal?: unknown };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  if (stderr.trim()) {
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => !/^Command failed:/i.test(line)) ?? lines[0]!;
  }
  if (failure.killed === true || typeof failure.signal === 'string') return 'GitHub did not answer in time. Refresh to try again.';
  // Without stderr, everything after "Command failed:" is the argv, which is query text.
  if (/^Command failed:/i.test(message)) return 'GitHub request failed. Refresh to try again.';
  return message.split('\n').map((line) => line.trim()).find(Boolean) ?? 'gh failed';
}

export function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'gh failed';
}

/**
 * The repo handle, memoized in the same map `resolveRepoHandle` uses — but rethrowing instead of
 * answering `null`.
 */
export async function resolveRepoHandleStrict(
  repoRoot: string,
  context = githubContext(repoRoot),
): Promise<{ owner: string; name: string } | null> {
  return sharedRepoHandle(repoRoot, undefined, context);
}

/** Is this a reply we can still read aliases out of? `repository: null` says the handle did not
 *  resolve, which is a real failure and must not be read as "the numbers are all missing". */
export function hasResolvedRepository(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { data?: { repository?: unknown } };
    const repository = parsed?.data?.repository;
    return typeof repository === 'object' && repository !== null;
  } catch {
    return false;
  }
}

/**
 * Use failed gh GraphQL stdout only when it contains usable data.repository. Preserve successful
 * aliases in partial responses; rethrow malformed or unresolved-repository failures.
 */
export function refStatusGraphql(repoRoot: string, context = githubContext(repoRoot)): GraphqlRunner {
  return async (query, variables) => {
    const args = ghGraphqlArgs(query, variables);
    try {
      return await gh(repoRoot, args, 15_000, undefined, context);
    } catch (err) {
      const stdout = (err as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && hasResolvedRepository(stdout)) return stdout;
      throw err;
    }
  };
}

/** CEZ_DRY_RUN=1 — a small fixed catalog so the GitHub tab is demoable offline. */
export function mockGithub(): GithubData {
  const mk = (over: Partial<GithubItem> & Pick<GithubItem, 'kind' | 'number' | 'title' | 'body'>): GithubItem => ({
    author: 'mock',
    createdAt: new Date(Date.now() - over.number * 3_600_000).toISOString(),
    labels: [],
    url: `https://github.com/mock/repo/${over.kind === 'pr' ? 'pull' : 'issues'}/${over.number}`,
    comments: 0,
    ...over,
  });
  return {
    available: true,
    repo: 'mock/repo',
    viewerLogin: 'octocat',
    projects: [{ id: 'mock-delivery', title: 'Delivery', url: 'https://github.com/users/mock/projects/1' }],
    syncedAt: new Date().toISOString(),
    issues: [
      mk({ kind: 'issue', assignees: ['octocat'], projectIds: ['mock-delivery'], number: 142, title: 'Login form drops session on refresh', labels: ['bug', 'auth'], comments: 3, body: 'Repro: log in, hit reload — you land back on /login. The session cookie is set correctly, but the client store rehydrates before the cookie check resolves, so the auth guard redirects.' }),
      mk({ kind: 'issue', assignees: ['ada'], projectIds: [], number: 139, title: 'Add --json flag to cez CLI output', labels: ['enhancement', 'cli'], comments: 1, body: 'For scripting it would help if `cez list` and `cez status` could emit machine-readable JSON instead of the table view.' }),
      mk({ kind: 'issue', assignees: [], projectIds: ['mock-delivery'], number: 135, title: 'Flaky e2e: worktree cleanup race on cancel', labels: ['bug', 'flaky-test'], comments: 6, body: 'Cancelling a run while the agent holds a file lock leaves a dangling worktree. The next run on the same branch then fails with "worktree already exists".' }),
    ],
    prs: [
      mk({ kind: 'pr', number: 128, title: 'Fix flaky auth test in CI', labels: ['tests'], checks: 'passing', additions: 6, deletions: 3, body: 'Loosens the timing assertion in refresh.test.ts to a realistic budget.' }),
      mk({ kind: 'pr', number: 124, title: 'Rate limit /api/runs', labels: ['server', 'draft'], isDraft: true, checks: 'failing', additions: 118, deletions: 7, comments: 4, body: 'Draft: token-bucket middleware on the runs router. Still needs the config surface and README docs before review.' }),
    ],
    labelColors: {
      bug: 'd73a4a',
      auth: '5319e7',
      enhancement: 'a2eeef',
      cli: '0e8a16',
      'flaky-test': 'fbca04',
      tests: 'c5def5',
      server: '1d76db',
      draft: '6a737d',
    },
  };
}

/**
 * Cached availability probe so `GET /api/health` never pays a full listing. Keyed by GitHub context (root, host, account).
 */
const DETECT_CACHE_MAX = 64;
const detectCache = new Map<string, { at: number; result: ForgeAvailability }>();
const detectInflight = new Map<string, Promise<ForgeAvailability>>();

async function probeGithub(repoRoot: string, context: GithubContext): Promise<ForgeAvailability> {
  let result: ForgeAvailability;
  try {
    await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner'], 5_000, undefined, context);
    result = { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
  detectCache.delete(context.key); // re-insert so Map order tracks recency
  detectCache.set(context.key, { at: Date.now(), result });
  while (detectCache.size > DETECT_CACHE_MAX) {
    const oldest = detectCache.keys().next().value;
    if (oldest === undefined) break;
    detectCache.delete(oldest);
  }
  return result;
}

export async function detectGithub(repoRoot: string): Promise<ForgeAvailability> {
  if (productEnv('DRY_RUN') === '1') return { available: true };
  const context = githubContext(repoRoot);
  const hit = detectCache.get(context.key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const pending = detectInflight.get(context.key);
  if (pending) return pending;
  const probe = probeGithub(repoRoot, context).finally(() => detectInflight.delete(context.key));
  detectInflight.set(context.key, probe);
  return probe;
}

/** How old an availability answer `/health` serves before it probes again (hearsay-tools/squawk#3658). */
export const HEALTH_AVAILABILITY_TTL_MS = 10 * 60_000;

/**
 * Non-blocking availability for `GET /api/health` (#major-health-latency): serves the last-known
 * probe immediately (stale-while-revalidate) and only returns `null` on a cold start, before the
 * first probe has ever warmed the cache.
 */
export function detectGithubCached(repoRoot: string): ForgeAvailability | null {
  if (productEnv('DRY_RUN') === '1') return { available: true };
  const hit = detectCache.get(githubContext(repoRoot).key);
  const cached = hit?.result ?? null;
  const fresh = hit !== undefined && Date.now() - hit.at < HEALTH_AVAILABILITY_TTL_MS;
  if (!fresh) {
    void detectGithub(repoRoot).catch(() => {}); // revalidate off the request path
  }
  return cached; // last-known value while revalidating; null only until the first probe warms
}
