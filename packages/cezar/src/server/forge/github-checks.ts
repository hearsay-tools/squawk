import { z } from 'zod';
import { productEnv } from '../../core/product-env.ts';
import { gh, githubContext, parseOwnerName } from './github-cli.ts';
import {
  CACHE_MS,
  firstLine,
  ghGraphqlArgs,
  mockGithub,
  rollupToChecks,
  type GraphqlRunner,
} from './github-shared.ts';
import type { ForgeTimelineEvent } from './types.ts';

/** SHAs per rollup query. Aliases resolve independently, so a chunk that fails costs only its own
 *  glyphs — but an unbounded alias list would eventually blow the query size limit. */
export const COMMIT_CHECKS_CHUNK = 50;

function commitChecksQuery(shas: string[]): string {
  const aliases = shas
    .map((sha, i) => `    c${i}: object(oid: "${sha}") { ... on Commit { statusCheckRollup { state } } }`)
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${aliases}\n  }\n}`;
}

const ghCommitChecksSchema = z.record(
  z.string(),
  z.object({ statusCheckRollup: z.object({ state: z.string().nullish() }).nullish() }).nullish(),
);

/**
 * Rolled-up CI state per commit SHA, as a `sha → checks` map.
 */
export async function fetchCommitChecks(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  shas: string[],
  chunkSize = COMMIT_CHECKS_CHUNK,
): Promise<Record<string, ForgeTimelineEvent['checks']>> {
  const out: Record<string, ForgeTimelineEvent['checks']> = {};
  if (shas.length === 0) return out;

  for (let i = 0; i < shas.length; i += chunkSize) {
    const chunk = shas.slice(i, i + chunkSize);
    try {
      const raw = JSON.parse(await runGraphql(commitChecksQuery(chunk), { owner, name })) as {
        data?: { repository?: unknown };
      };
      const repository = ghCommitChecksSchema.parse(raw?.data?.repository ?? {});
      chunk.forEach((sha, index) => {
        const node = repository[`c${index}`];
        if (!node) return;
        out[sha] = node.statusCheckRollup
          ? rollupToChecks([{ state: node.statusCheckRollup.state, status: null, conclusion: null }])
          : null;
      });
    } catch {
      // A failed chunk costs only its own glyphs; the rest still resolve.
    }
  }
  return out;
}

/** The single enum a PR row's checks glyph renders (never `undefined` on the wire). */
export type ChecksGlyph = 'passing' | 'failing' | 'pending' | null;

export type GithubChecksData =
  | { available: true; checks: Record<number, ChecksGlyph> }
  | { available: false; reason: string };

/** PR numbers per checks query. */
export const GH_CHECKS_MAX = 100;

function prChecksQuery(numbers: number[]): string {
  const aliases = numbers
    .map(
      (n, i) =>
        `    p${i}: pullRequest(number: ${n}) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`,
    )
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${aliases}\n  }\n}`;
}

const ghPrChecksSchema = z.record(
  z.string(),
  z
    .object({
      commits: z.object({
        nodes: z.array(
          z.object({
            commit: z.object({
              statusCheckRollup: z.object({ state: z.string().nullish() }).nullish(),
            }),
          }),
        ),
      }),
    })
    .nullish(),
);

/**
 * Rolled-up CI state per PR number, as a `number → glyph` map.
 */
export async function fetchPrChecks(
  runGraphql: GraphqlRunner,
  owner: string,
  name: string,
  numbers: number[],
  chunkSize = GH_CHECKS_MAX,
): Promise<Record<number, ChecksGlyph>> {
  const out: Record<number, ChecksGlyph> = {};
  if (numbers.length === 0) return out;

  for (let i = 0; i < numbers.length; i += chunkSize) {
    const chunk = numbers.slice(i, i + chunkSize);
    try {
      const raw = JSON.parse(await runGraphql(prChecksQuery(chunk), { owner, name })) as {
        data?: { repository?: unknown };
      };
      const repository = ghPrChecksSchema.parse(raw?.data?.repository ?? {});
      chunk.forEach((number, index) => {
        const node = repository[`p${index}`];
        if (!node) return;
        const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
        out[number] = rollup
          ? rollupToChecks([{ state: rollup.state, status: null, conclusion: null }]) ?? null
          : null;
      });
    } catch {
      // A failed chunk costs only its own glyphs; the rest still resolve.
    }
  }
  return out;
}

const checksCache = new Map<string, { at: number; glyph: ChecksGlyph }>();
export const CHECKS_CACHE_MAX = 500;

/** Test hook — the per-PR checks cache would otherwise leak state across cases in one process. */
export function __clearChecksCacheForTests(): void {
  checksCache.clear();
}

/**
 * Lazy checks glyphs for the given PR numbers (route-facing).
 */
export async function fetchGithubChecks(repoRoot: string, numbers: number[]): Promise<GithubChecksData> {
  if (productEnv('DRY_RUN') === '1') return mockGithubChecks(numbers);
  const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).slice(0, GH_CHECKS_MAX);
  const checks: Record<number, ChecksGlyph> = {};
  const misses: number[] = [];
  const now = Date.now();
  const context = githubContext(repoRoot);
  for (const n of wanted) {
    const hit = checksCache.get(`${context.key}\0${n}`);
    if (hit && now - hit.at < CACHE_MS) checks[n] = hit.glyph;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, checks };
  try {
    const repoOut = await gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], undefined, undefined, context);
    const ownerName = parseOwnerName(repoOut);
    if (!ownerName) return { available: false, reason: 'repository handle unavailable' };
    const runGraphql: GraphqlRunner = (query, variables) => {
      const args = ghGraphqlArgs(query, variables);
      return gh(repoRoot, args, undefined, undefined, context);
    };
    const fetched = await fetchPrChecks(runGraphql, ownerName.owner, ownerName.name, misses);
    for (const n of misses) {
      const glyph: ChecksGlyph = n in fetched ? fetched[n]! : null;
      checks[n] = glyph;
      checksCache.set(`${context.key}\0${n}`, { at: now, glyph });
    }
    while (checksCache.size > CHECKS_CACHE_MAX) {
      const oldest = checksCache.keys().next().value;
      if (oldest === undefined) break;
      checksCache.delete(oldest);
    }
    return { available: true, checks };
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

function mockGithubChecks(numbers: number[]): GithubChecksData {
  const byNumber = new Map(mockGithub().prs.map((p) => [p.number, (p.checks ?? null) as ChecksGlyph]));
  const checks: Record<number, ChecksGlyph> = {};
  for (const n of numbers) checks[n] = byNumber.get(n) ?? null;
  return { available: true, checks };
}
