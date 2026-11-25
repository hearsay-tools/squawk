import { productEnv } from '../../core/product-env.ts';
import { githubContext, type GithubContext } from './github-cli.ts';
import {
  CACHE_MS,
  firstLine,
  mockGithub,
  refStatusGraphql,
  resolveRepoHandleStrict,
} from './github-shared.ts';
import type { ChecksGlyph } from './github-checks.ts';
import {
  derivePrReferenceStatus,
  fetchRefStatuses,
  GH_REF_STATUS_MAX,
  type GithubRefStatusData,
  type ReferenceStatus,
  type ResolvedReference,
} from './github-ref-status-derive.ts';

const refStatusCache = new Map<
  string,
  { at: number; resolved: ResolvedReference | null; unknownSince?: number }
>();
const REF_STATUS_CACHE_MAX = 500;

type RefStatusResult = { resolved: ResolvedReference | null; unknownSince?: number } | { reason: string };
const refStatusFlights = new Map<string, Promise<RefStatusResult>>();

/** Test-only: drop the per-reference cache so cases don't leak state into each other. */
export function __clearRefStatusCacheForTests(): void {
  refStatusCache.clear();
  refStatusFlights.clear();
}

/** Test-only: warm the cache the way the lazy route would have. */
export function __seedRefStatusCacheForTests(
  repoRoot: string,
  entries: Array<[number, ResolvedReference]>,
): void {
  for (const [number, resolved] of entries) {
    refStatusCache.set(refStatusKey(repoRoot, number), { at: Date.now(), resolved });
  }
}

/**
 * Invalidate one reference after a known mutation.
 */
export function forgetRefStatus(repoRoot: string, number: number): void {
  refStatusCache.delete(refStatusKey(repoRoot, number));
  refStatusFlights.delete(refStatusKey(repoRoot, number));
}

/**
 * Everything the cache ALREADY knows about these numbers. Never spawns `gh`, never awaits.
 */
export function readCachedRefStatuses(
  repoRoot: string,
  numbers: Iterable<number>,
): { prs: Record<number, ReferenceStatus>; issues: Record<number, ReferenceStatus> } {
  const out = { prs: {} as Record<number, ReferenceStatus>, issues: {} as Record<number, ReferenceStatus> };
  const now = Date.now();
  for (const number of new Set(numbers)) {
    const hit = refStatusCache.get(refStatusKey(repoRoot, number));
    if (!hit || !hit.resolved || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) continue;
    out[hit.resolved.kind === 'pr' ? 'prs' : 'issues'][number] = hit.resolved.status;
  }
  return out;
}

const REF_STATUS_CLOSED_TTL = 10 * 60_000;
const REF_STATUS_MERGED_TTL = 24 * 60 * 60_000;
const MERGEABILITY_UNKNOWN_TTL_MS = 5_000;
const MERGEABILITY_UNKNOWN_WINDOW_MS = 60_000;
const REF_STATUS_RETRY_MS = 5 * 60_000;

function refStatusTtl(entry: ResolvedReference | null, unknownSince?: number, now = Date.now()): number {
  if (!entry) return CACHE_MS;
  if (
    entry.mergeable === 'unknown' &&
    unknownSince !== undefined &&
    now - unknownSince < MERGEABILITY_UNKNOWN_WINDOW_MS
  ) {
    return MERGEABILITY_UNKNOWN_TTL_MS;
  }
  switch (entry.status) {
    case 'merged':
      return REF_STATUS_MERGED_TTL;
    case 'closed':
    case 'completed':
    case 'not-planned':
      return REF_STATUS_CLOSED_TTL;
    default:
      return CACHE_MS;
  }
}

function refStatusRecheckAfter(entry: ResolvedReference | null, unknownSince?: number, now = Date.now()): number | null {
  if (entry?.status === 'merged') return null;
  return refStatusTtl(entry, unknownSince, now);
}

function batchRecheckAfter(rechecks: (number | null)[]): number | null {
  let soonest: number | null = null;
  for (const after of rechecks) {
    if (after === null) continue;
    soonest = soonest === null ? after : Math.min(soonest, after);
  }
  return soonest;
}

async function sharedRefStatusMisses(repoRoot: string, numbers: number[], context: GithubContext): Promise<Array<[number, RefStatusResult]>> {
  const pending = new Map<number, Promise<RefStatusResult>>();
  const owned: number[] = [];
  for (const n of numbers) {
    const flight = refStatusFlights.get(refStatusKey(repoRoot, n, context));
    if (flight) pending.set(n, flight);
    else owned.push(n);
  }
  if (owned.length) {
    const batch = (async () => {
      const handle = await resolveRepoHandleStrict(repoRoot, context);
      if (!handle) throw new Error('repository handle unavailable');
      return fetchRefStatuses(refStatusGraphql(repoRoot, context), handle.owner, handle.name, owned);
    })();
    for (const n of owned) {
      const key = refStatusKey(repoRoot, n, context);
      const tracked = refStatusFlights.size < REF_STATUS_CACHE_MAX;
      const promise: Promise<RefStatusResult> = batch.then(result => {
        if (result.failed.includes(n)) return { reason: result.reason ?? 'GitHub could not be reached' };
        const storedAt = Date.now();
        const entry = result.resolved[n] ?? null;
        const unknownSince = entry?.mergeable === 'unknown'
          ? (refStatusCache.get(key)?.unknownSince ?? storedAt) : undefined;
        const value = { resolved: entry, ...(unknownSince === undefined ? {} : { unknownSince }) };
        if (tracked && refStatusFlights.get(key) === promise) {
          refStatusCache.set(key, { at: storedAt, ...value });
          while (refStatusCache.size > REF_STATUS_CACHE_MAX) refStatusCache.delete(refStatusCache.keys().next().value!);
        }
        return value;
      }).finally(() => {
        if (refStatusFlights.get(key) === promise) refStatusFlights.delete(key);
      });
      if (tracked) refStatusFlights.set(key, promise);
      pending.set(n, promise);
    }
  }
  return Promise.all(numbers.map(async n => [n, await pending.get(n)!] as [number, RefStatusResult]));
}

/**
 * Route-facing reference status.
 */
export async function fetchGithubRefStatus(
  repoRoot: string,
  input: { prs?: number[]; issues?: number[] },
): Promise<GithubRefStatusData> {
  const context = githubContext(repoRoot);
  const asPrs = sanitizeRefNumbers(input.prs);
  const asIssues = sanitizeRefNumbers(input.issues);
  if (productEnv('DRY_RUN') === '1') return mockGithubRefStatus(asPrs, asIssues);
  const wanted = [...new Set([...asPrs, ...asIssues])];

  const resolved = { prs: {} as Record<number, ReferenceStatus>, issues: {} as Record<number, ReferenceStatus> };
  const rechecks: (number | null)[] = [];
  const conflicts: number[] = [];
  const file = (number: number, entry: ResolvedReference | null, unknownSince?: number) => {
    rechecks.push(refStatusRecheckAfter(entry, unknownSince));
    if (!entry) return;
    resolved[entry.kind === 'pr' ? 'prs' : 'issues'][number] = entry.status;
    if (entry.mergeable === 'conflicting') conflicts.push(number);
  };
  const misses: number[] = [];
  const now = Date.now();
  for (const n of wanted) {
    const hit = refStatusCache.get(refStatusKey(repoRoot, n, context));
    if (!hit || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) misses.push(n);
    else file(n, hit.resolved, hit.unknownSince);
  }
  if (misses.length === 0) {
    return {
      available: true,
      prs: resolved.prs,
      issues: resolved.issues,
      conflicts,
      recheckAfterMs: batchRecheckAfter(rechecks),
    };
  }
  try {
    const entries = await sharedRefStatusMisses(repoRoot, misses, context);
    let failure: string | undefined;
    for (const [n, result] of entries) {
      if ('reason' in result) failure ??= result.reason;
      else file(n, result.resolved, result.unknownSince);
    }
    if (failure !== undefined) {
      return {
        available: false,
        reason: failure,
        recheckAfterMs: REF_STATUS_RETRY_MS,
      };
    }
    return {
      available: true,
      prs: resolved.prs,
      issues: resolved.issues,
      conflicts,
      recheckAfterMs: batchRecheckAfter(rechecks),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
      recheckAfterMs: REF_STATUS_RETRY_MS,
    };
  }
}

function refStatusKey(repoRoot: string, number: number, context = githubContext(repoRoot)): string {
  return `${context.key}\0#${number}`;
}

function sanitizeRefNumbers(numbers: number[] | undefined): number[] {
  return [...new Set(numbers ?? [])].filter((n) => Number.isInteger(n) && n > 0).slice(0, GH_REF_STATUS_MAX);
}

function mockGithubRefStatus(prs: number[], issues: number[]): GithubRefStatusData {
  const catalog = mockGithub();
  const byPr = new Map(catalog.prs.map((p) => [p.number, p]));
  const byIssue = new Set(catalog.issues.map((i) => i.number));
  const out: GithubRefStatusData = { available: true, prs: {}, issues: {}, recheckAfterMs: CACHE_MS };
  for (const n of prs) {
    const pr = byPr.get(n);
    if (pr) {
      out.prs[n] = derivePrReferenceStatus({
        state: 'OPEN',
        isDraft: pr.isDraft,
        reviewDecision: null,
        checks: (pr.checks ?? null) as ChecksGlyph,
      });
    }
  }
  for (const n of issues) if (byIssue.has(n)) out.issues[n] = 'open';
  return out;
}
