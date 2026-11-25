import type {
  GithubChecksData,
  GithubCommentCountsData,
  GithubCommentsData,
  GithubData,
  GithubItemResponse,
  GithubMergeMethod,
  GithubMergeResponse,
  GithubPrChangesData,
  GithubPrMergeStateResponse,
  GithubProjectsData,
  GithubRefStatusData,
  GithubSearchData,
} from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { cez, init, unwrap, type ReadOptions } from './client-core'

/** Issues + PRs via the logged-in `gh`. Degrades to `{ available: false, reason }` server-side —
 *  an unreachable forge is a hint in the tab, not an ApiError. */
export async function getGithub(
  /** `projectId` is for callers that render outside the routed view's scope (the shell's sidebar
   *  list, which sits above the provider); everyone else leaves it to `queryScope()`. */
  params: {
    limit?: number | undefined; refresh?: boolean; projectId?: string | undefined
    /** One page (hearsay-tools/cezarion#1183): each side's cursor, or that side done. */
    issuesCursor?: string; prsCursor?: string; issuesDone?: boolean; prsDone?: boolean
  } = {},
  opts?: ReadOptions,
): Promise<GithubData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.$get(
      {
        param: { projectId: params.projectId ?? queryScope() },
        // `refresh: false` sends nothing at all — the server tests `=== '1'`, and a parameter we
        // do not mean is how a "false" ends up read as truthy somewhere downstream.
        query: {
          limit: params.limit === undefined ? undefined : String(params.limit),
          refresh: params.refresh ? '1' : undefined,
          issuesCursor: params.issuesCursor,
          prsCursor: params.prsCursor,
          issuesDone: params.issuesDone ? '1' : undefined,
          prsDone: params.prsDone ? '1' : undefined,
        },
      },
      init(opts),
    ),
    '/github',
  )
}

/** Comment counts for loaded list rows (hearsay-tools/cezarion#1183), which the list defers.
 *  Degrades to `{ available: false, reason }` server-side — a missing badge, never an ApiError. */
export async function getGithubCommentCounts(
  kind: 'issue' | 'pr',
  numbers: readonly number[],
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubCommentCountsData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github['comment-counts'].$get(
      {
        param: { projectId: queryScope() },
        query: { kind, numbers: numbers.join(','), refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    '/github/comment-counts',
  )
}

export async function getGithubProjects(generation: string, opts?: ReadOptions): Promise<GithubProjectsData> {
  return unwrap(await cez.api.v1.p[':projectId'].github.projects.$get({
    param: { projectId: queryScope() }, query: { generation },
  }, init(opts)), '/github/projects')
}

/** Lazy PR checks glyphs for on-screen rows (#664). The list call no longer ships
 *  `statusCheckRollup`; this fills the glyph in per visible PR. Degrades to
 *  `{ available: false, reason }` server-side — a missing glyph, never an ApiError. */
export async function getGithubChecks(
  prNumbers: number[],
  opts?: ReadOptions,
): Promise<GithubChecksData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.checks.$get(
      { param: { projectId: queryScope() }, query: { prs: prNumbers.join(',') } },
      init(opts),
    ),
    '/github/checks',
  )
}

/** Search issues/PRs in ANY state (#730). `getGithub` lists the open set only, so the tab's
 *  in-memory filter cannot reach a closed or merged item — this is the fallback it calls when the
 *  local filter comes up empty. Degrades to `{ available: false, reason }` server-side. */
export async function getGithubSearch(
  kind: 'issue' | 'pr',
  query: string,
  params: { limit?: number | undefined; projectId?: string | undefined } = {},
  opts?: ReadOptions,
): Promise<GithubSearchData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.search.$get(
      {
        param: { projectId: params.projectId ?? queryScope() },
        // The search route validates `limit` with `z.coerce.number()`, so the typed client's
        // query input is `number | undefined` — pass the number, not a stringified copy (the
        // `/github` list route below coerces from a bare string, hence the difference).
        query: { kind, q: query, limit: params.limit },
      },
      init(opts),
    ),
    '/github/search',
  )
}

/**
 * Batched status for the PR/issue chips on screen. Takes its project EXPLICITLY, like
 * `getRuns` and `archiveRun` and for the same reason: the global Tasks page stands
 * outside every `/p/:projectId`, and its rows belong to different projects — `queryScope()` would
 * ask the boot project about another project's PR number and get a confident wrong answer.
 * Callers standing in one project pass their own id.
 *
 * Degrades to `{ available: false, reason }` server-side; an absent number is "nothing known",
 * which the chip renders exactly as it did before statuses existed.
 */
export async function getGithubRefStatus(
  projectId: string,
  refs: { prs?: readonly number[]; issues?: readonly number[] },
  opts?: ReadOptions,
): Promise<GithubRefStatusData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github['ref-status'].$get(
      {
        param: { projectId },
        query: {
          // Spread conditionally: the route reads an ABSENT key as "not asked for", and an empty
          // string would be a malformed list (a 400) rather than a silent no-op.
          ...(refs.prs?.length ? { prs: refs.prs.join(',') } : {}),
          ...(refs.issues?.length ? { issues: refs.issues.join(',') } : {}),
        },
      },
      init(opts),
    ),
    '/github/ref-status',
  )
}

/** The full comment thread for one issue/PR (#499). Degrades to `{ available: false, reason }`
 *  server-side — an unreachable thread is a one-line hint in the detail view, not an ApiError. */
export async function getGithubComments(
  kind: 'issue' | 'pr',
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubCommentsData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.comments[':kind'][':number'].$get(
      {
        param: { projectId: queryScope(), kind, number: String(number) },
        // `refresh=1` is what busts the route's 60 s `commentsCache` (server.ts). Without it a
        // manual refresh re-requests and is handed the same cached object — the caller must be
        // able to say "actually go and ask gh", exactly as `getGithub` can.
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/comments/${kind}/${number}`,
  )
}

/** One issue or PR by number, in any state (#692) — the task page's item tabs. Degrades to
 *  `{ available: false, reason }` server-side; `item: null` means GitHub has no such number. */
export async function getGithubItem(
  kind: 'issue' | 'pr',
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubItemResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.items[':kind'][':number'].$get(
      {
        param: { projectId: opts?.projectId ?? queryScope(), kind, number: String(number) },
        // `refresh=1` busts the route's item cache, as it does for the comment thread above.
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/items/${kind}/${number}`,
  )
}

export async function getGithubPrMergeState(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrMergeStateResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number']['merge-state'].$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/merge-state`,
  )
}

export async function mergeGithubPr(
  number: number,
  input: { method: GithubMergeMethod; expectedHeadSha: string; overrideRules?: boolean },
): Promise<GithubMergeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].merge.$post({
      param: { projectId: queryScope(), number: String(number) },
      json: input,
    }),
    '/github/prs/:number/merge',
  )
}

export async function getGithubPrChanges(
  number: number,
  params: { refresh?: boolean } = {},
  opts?: ReadOptions,
): Promise<GithubPrChangesData> {
  return unwrap(
    await cez.api.v1.p[':projectId'].github.prs[':number'].changes.$get(
      {
        param: { projectId: queryScope(), number: String(number) },
        query: { refresh: params.refresh ? '1' : undefined },
      },
      init(opts),
    ),
    `/github/prs/${number}/changes`,
  )
}
