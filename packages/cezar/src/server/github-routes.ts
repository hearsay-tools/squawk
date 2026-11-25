import { Hono } from 'hono';
import { z } from 'zod';
import {
  githubCommentCountsQuerySchema,
  githubItemParamsSchema,
  githubListQuerySchema,
  githubProjectsQuerySchema,
  githubSearchQuerySchema,
} from '@open-mercato/cezar-contract/github';
import {
  githubChecksQuerySchema,
  githubRefsQuerySchema,
  mergeBodySchema,
  mergeNumberParams,
  prChangesParams,
  prChangesQuery,
} from '@open-mercato/cezar-contract/github-requests';
import { refreshQuery } from '@open-mercato/cezar-contract/query-requests';
import {
  GH_CHECKS_MAX,
  GH_REF_STATUS_MAX,
  GithubPrNotFoundError,
  resolveForgeRoot,
  type ForgeFactory,
  type resolveForge,
} from './forge/index.ts';
import { getRepoInfo } from './git.ts';
import type { ProjectApiEnv } from './server-types.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';

const commentsParams = z.object({
  kind: z.enum(['issue', 'pr']),
  number: z.coerce.number().int().positive(),
});

function parseRefNumbers(raw: string | undefined): number[] | null {
  const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > GH_REF_STATUS_MAX) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return null;
    numbers.push(n);
  }
  return numbers;
}

export interface GithubRouteDeps {
  forgeFactory?: ForgeFactory | undefined;
  resolveProjectForge: (info: Awaited<ReturnType<typeof getRepoInfo>>) => ReturnType<typeof resolveForge>;
}

export function createGithubRoutes(deps: GithubRouteDeps) {
  const { forgeFactory, resolveProjectForge } = deps;

  return new Hono<ProjectApiEnv>()
    .get(
      '/github',
      queryZodValidator(githubListQuerySchema),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const query = c.req.valid('query');
        const limit = Number.parseInt(query.limit ?? '', 10);
        return c.json(await resolveForgeRoot(repoRoot, forgeFactory).list({
          refresh: query.refresh === '1',
          limit: Number.isFinite(limit) ? limit : 30,
          issuesCursor: query.issuesCursor,
          prsCursor: query.prsCursor,
          issuesDone: query.issuesDone === '1',
          prsDone: query.prsDone === '1',
        }));
      },
    )
    .get('/github/projects', queryZodValidator(githubProjectsQuerySchema), async (c) => {
      return c.json(await resolveForgeRoot(c.get('project').root, forgeFactory).projects(c.req.valid('query').generation));
    })
    .get('/github/comments/:kind/:number', queryZodValidator(refreshQuery), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = commentsParams.safeParse({
        kind: c.req.param('kind'),
        number: c.req.param('number'),
      });
      if (!parsed.success) return c.json({ error: 'invalid kind or number' }, 400);
      return c.json(
        await resolveForgeRoot(repoRoot, forgeFactory).comments(parsed.data.kind, parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }),
      );
    })
    .get(
      '/github/items/:kind/:number',
      paramZodValidator(githubItemParamsSchema, { message: 'invalid kind or number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { kind, number } = c.req.valid('param');
        return c.json(await resolveForgeRoot(repoRoot, forgeFactory).item(kind, number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )
    .get('/github/checks', queryZodValidator(githubChecksQuerySchema, { message: 'missing prs query' }), async (c) => {
      const { root: repoRoot } = c.get('project');
      const raw = c.req.valid('query').prs;
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0 || parts.length > GH_CHECKS_MAX) return c.json({ error: 'invalid prs query' }, 400);
      const numbers: number[] = [];
      for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return c.json({ error: 'invalid prs query' }, 400);
        numbers.push(n);
      }
      return c.json(await resolveForgeRoot(repoRoot, forgeFactory).checks(numbers));
    })
    .get('/github/comment-counts', queryZodValidator(githubCommentCountsQuerySchema, { message: 'invalid comment-counts query' }), async (c) => {
      const { kind, numbers, refresh } = c.req.valid('query');
      return c.json(await resolveForgeRoot(c.get('project').root, forgeFactory).commentCounts(kind, numbers.split(',').map(Number), { refresh: refresh === '1' }));
    })
    .get(
      '/github/search',
      queryZodValidator(
        githubSearchQuerySchema,
        { message: 'invalid search query' },
      ),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { kind, q, limit } = c.req.valid('query');
        const forge = resolveForgeRoot(repoRoot, forgeFactory);
        if (!forge.searchItems) return c.json({ available: false, reason: 'GitHub is unavailable', items: [] });
        return c.json(await forge.searchItems(kind, q, limit === undefined ? {} : { limit }));
      },
    )
    .get(
      '/github/ref-status',
      queryZodValidator(githubRefsQuerySchema),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { prs, issues } = c.req.valid('query');
        const parsedPrs = parseRefNumbers(prs);
        const parsedIssues = parseRefNumbers(issues);
        if (parsedPrs === null || parsedIssues === null) return c.json({ error: 'invalid ref-status query' }, 400);
        if (parsedPrs.length === 0 && parsedIssues.length === 0) {
          return c.json({ error: 'missing prs or issues query' }, 400);
        }
        return c.json(await resolveForgeRoot(repoRoot, forgeFactory).refStatus({ prs: parsedPrs, issues: parsedIssues }));
      },
    )
    .get(
      '/github/prs/:number/merge-state',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveProjectForge(await getRepoInfo(repoRoot));
        if (!forge?.prMergeState) return c.json({ available: false, reason: 'GitHub merge state is unavailable' });
        return c.json(await forge.prMergeState(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )
    .post(
      '/github/prs/:number/merge',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      jsonZodValidator(() => mergeBodySchema, { message: 'invalid merge request' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsedNumber = { data: c.req.valid('param') };
        const body = { data: c.req.valid('json') };
        const forge = resolveProjectForge(await getRepoInfo(repoRoot));
        if (!forge?.mergePR) return c.json({ error: 'GitHub merge is unavailable' }, 409);
        const result = await forge.mergePR(parsedNumber.data.number, body.data);
        if (result.merged) {
          return c.json(result);
        }
        return c.json(
          {
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.current ? { current: result.current } : {}),
          },
          result.status,
        );
      },
    )
    .get(
      '/github/prs/:number/changes',
      paramZodValidator(prChangesParams, { message: 'invalid pull request number or refresh flag' }),
      queryZodValidator(prChangesQuery, { message: 'invalid pull request number or refresh flag' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveForgeRoot(repoRoot, forgeFactory);
        if (!forge.prDiff) return c.json({ available: false, reason: 'GitHub is unavailable' });
        try {
          return c.json(
            await forge.prDiff(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }),
          );
        } catch (err) {
          if (err instanceof GithubPrNotFoundError) return c.json({ error: err.message }, 404);
          throw err;
        }
      },
    );
}
