import { productEnv } from '../../core/product-env.ts';
import { z } from 'zod';
import { gh } from './github-cli.ts';
import { CACHE_MS, firstLine } from './github-shared.ts';
import type { ForgePrDiffResult } from './types.ts';

export const GH_PR_DIFF_FILE_CAP = 300;
export const GH_PR_PATCH_CAP = 512 * 1024;
export const GH_PR_DIFF_JSON_CAP = 4 * 1024 * 1024;

const ghPrFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const ghPrHeadSchema = z.object({ headRefOid: z.string().regex(/^[0-9a-f]{40}$/i) });

export class GithubPrNotFoundError extends Error {}

const prDiffCache = new Map<string, { at: number; data: ForgePrDiffResult }>();

export type PrFilesPageRunner = (page: number) => Promise<string>;

/** Fetch no more than the three GitHub pages represented by the public 300-file response cap. */
export async function fetchPrFilePages(runPage: PrFilesPageRunner): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= GH_PR_DIFF_FILE_CAP / 100; page++) {
    const next = z.array(z.unknown()).parse(JSON.parse(await runPage(page)));
    rows.push(...next);
    if (next.length < 100) break;
  }
  return rows;
}

export async function fetchGithubPrDiff(
  repoRoot: string,
  number: number,
  refresh = false,
): Promise<ForgePrDiffResult> {
  if (productEnv('DRY_RUN') === '1') return mockGithubPrDiff(number);
  try {
    const head = ghPrHeadSchema.parse(
      JSON.parse(await gh(repoRoot, ['pr', 'view', String(number), '--json', 'headRefOid'])),
    ).headRefOid;
    const key = `${repoRoot}\0${number}\0${head}`;
    const hit = prDiffCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const rows = z.array(ghPrFileSchema).parse(
      await fetchPrFilePages((page) =>
        gh(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${number}/files?per_page=100&page=${page}`], 30_000),
      ),
    );
    const limited = rows.slice(0, GH_PR_DIFF_FILE_CAP);
    // A full third page may have a successor. Without fetching a 301st file, conservatively call
    // the response partial rather than claiming completeness we cannot prove.
    let responseTruncated = rows.length >= GH_PR_DIFF_FILE_CAP;
    const reasons: string[] = responseTruncated ? [`Only the first ${GH_PR_DIFF_FILE_CAP} files are shown.`] : [];
    const files = limited.map((row) => {
      let patch = row.patch;
      let truncated = false;
      let patchUnavailableReason: 'binary' | 'too-large' | 'not-provided' | undefined;
      if (patch !== undefined && Buffer.byteLength(patch, 'utf8') > GH_PR_PATCH_CAP) {
        patch = undefined;
        truncated = true;
        patchUnavailableReason = 'too-large';
        responseTruncated = true;
      } else if (patch === undefined) {
        patchUnavailableReason = row.additions === 0 && row.deletions === 0 ? 'binary' : 'not-provided';
      }
      return {
        path: row.filename,
        ...(row.previous_filename ? { previousPath: row.previous_filename } : {}),
        status: row.status,
        additions: row.additions,
        deletions: row.deletions,
        ...(patch !== undefined ? { patch } : {}),
        ...(patchUnavailableReason ? { patchUnavailableReason } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    });
    let kept = files;
    while (
      kept.length > 0 &&
      Buffer.byteLength(JSON.stringify({ available: true, number, headSha: head, files: kept }), 'utf8') >
        GH_PR_DIFF_JSON_CAP
    ) {
      kept = kept.slice(0, -1);
      responseTruncated = true;
    }
    if (kept.length < files.length) reasons.push('The response size limit omitted some files.');
    if (files.some((file) => file.truncated)) reasons.push('One or more patches exceeded the per-file limit.');
    const data: ForgePrDiffResult = {
      available: true,
      number,
      headSha: head,
      files: kept,
      additions: rows.reduce((sum, row) => sum + row.additions, 0),
      deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
      truncated: responseTruncated,
      ...(reasons.length ? { reason: reasons.join(' ') } : {}),
    };
    prDiffCache.set(key, { at: Date.now(), data });
    while (prDiffCache.size > 50) prDiffCache.delete(prDiffCache.keys().next().value!);
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|Could not resolve to a PullRequest|no pull requests found/i.test(message)) {
      throw new GithubPrNotFoundError(`Pull request #${number} was not found`);
    }
    return {
      available: false,
      reason: /ENOENT/.test(message)
        ? 'gh CLI not found — install it and run `gh auth login`'
        : firstLine(message),
    };
  }
}

function mockGithubPrDiff(number: number): ForgePrDiffResult {
  return {
    available: true,
    number,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    additions: 15,
    deletions: 4,
    truncated: true,
    reason: 'One or more patches were not provided by GitHub.',
    files: [
      { path: 'src/session.ts', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1,3 +1,4 @@\n-old\n+new\n context' },
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 7, deletions: 1, patch: '@@ -1 +1 @@\n-old name\n+new name' },
      { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
      { path: 'generated/output.txt', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'too-large', truncated: true },
    ],
  };
}
