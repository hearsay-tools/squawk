import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { Runner } from '@open-mercato/cezar-api-client'
import { RUNS_INDEX_QUERY_KEY } from './runs-index-sync'

/**
 * Shared hierarchical query keys, prefixed by the current project scope at access time. Stream
 * handlers and consumers must use these keys for matching invalidation.
 */
export const queryKeys = {
  get health() {
    return [queryScope(), 'health'] as const
  },
  runs: {
    get all() {
      return [queryScope(), 'runs'] as const
    },
    relationships: (id: string) => [queryScope(), 'runs', 'relationships', id] as const,
    list: (scope = queryScope()) => [scope, 'runs', 'list'] as const,
    /** Under `all`, so every run mutation's invalidation refreshes the archived pages too. */
    archived: (q: string) => [queryScope(), 'runs', 'archived', q] as const,
    detail: (id: string, scope = queryScope()) => [scope, 'runs', 'detail', id] as const,
    diff: (id: string) => [queryScope(), 'runs', 'diff', id] as const,
    changes: (id: string) => [queryScope(), 'runs', 'changes', id] as const,
    file: (id: string, path: string) => [queryScope(), 'runs', 'files', id, path] as const,
    handoff: (id: string) => [queryScope(), 'runs', 'handoff', id] as const,
    commits: (id: string) => [queryScope(), 'runs', 'commits', id] as const,
    commit: (id: string, sha: string) => [queryScope(), 'runs', 'commit', id, sha] as const,
  },
  get workflows() {
    return [queryScope(), 'workflows'] as const
  },
  runnerSkills: (runner: Runner, account?: string | null) => [queryScope(), 'runner-skills', runner, account ?? null] as const,
  get repo() {
    return [queryScope(), 'repo'] as const
  },
  /** Children of `repo` on purpose: invalidating `queryKeys.repo` (a branch switch, a new
   *  commit) prefix-matches the working-tree diff and every cached commit diff too. */
  get repoChanges() {
    return [queryScope(), 'repo', 'changes'] as const
  },
  repoCommit: (sha: string) => [queryScope(), 'repo', 'commit', sha] as const,
  /** The classified branch list (`GET /repo/branches`, issue 08). A child of `repo`, so a branch
   *  switch or pull refreshes it too; run events invalidate it on their own (global-events). */
  get repoBranches() {
    return [queryScope(), 'repo', 'branches'] as const
  },
  get uiState() {
    return [queryScope(), 'ui-state'] as const
  },
  /** The Settings → Agent defaults knobs (`GET /api/config`, R6 1.5). */
  get config() {
    return [queryScope(), 'config'] as const
  },
  get agentConfig() {
    return [queryScope(), 'agent-config'] as const
  },
  agentConfigFile: (id: string) => [queryScope(), 'agent-config', 'file', id] as const,
  /** Settings → Session context (hearsay-tools/squawk#4308): the file, and one preview per draft and role. */
  get sessionContext() {
    return [queryScope(), 'session-context'] as const
  },
  sessionContextPreview: (content: string, role: string) => [queryScope(), 'session-context', 'preview', role, content] as const,
  /** The worktree management panel (`GET /api/worktrees`, #483). */
  get worktrees() {
    return [queryScope(), 'worktrees'] as const
  },
  github: (params: { limit?: number | undefined } = {}) => [queryScope(), 'github', params.limit ?? null] as const,
  /** The paged list (hearsay-tools/cezarion#1183): one infinite query per page size. */
  githubPages: (pageSize: number) => [queryScope(), 'github', 'pages', pageSize] as const,
  /** Page 1 as the live read last saw it; reconciled into `githubPages`, never rendered. */
  githubPagesHead: (pageSize: number) => [queryScope(), 'github', 'pages-head', pageSize] as const,
  /** Deferred comment counts, keyed by kind and the sorted numbers. */
  githubCommentCounts: (kind: 'issue' | 'pr', numbers: readonly number[]) =>
    [queryScope(), 'github', 'comment-counts', kind, [...numbers].sort((a, b) => a - b).join(',')] as const,
  /** Lazy PR checks glyphs (`GET /api/github/checks`, #664), keyed by the sorted PR numbers so the
   *  same visible window de-dupes to one cache entry. */
  githubChecks: (prNumbers: readonly number[]) =>
    [queryScope(), 'github', 'checks', [...prNumbers].sort((a, b) => a - b).join(',')] as const,
  /** Cross-state search (`GET /api/github/search`, #730), keyed by kind + the exact query so each
   *  distinct search caches on its own and re-typing a previous query is instant. */
  githubSearch: (kind: 'issue' | 'pr', query: string) =>
    [queryScope(), 'github', 'search', kind, query] as const,
  /** Batched PR/issue chip status. Led by the EXPLICIT project rather than `queryScope()` —
   *  the global Tasks page asks about several projects at once, and two of them may each have a
   *  PR #42. Keyed by the sorted numbers, so the same window de-dupes to one cache entry. */
  githubRefStatus: (projectId: string, prNumbers: readonly number[], issueNumbers: readonly number[]) =>
    [
      projectId,
      'github',
      'ref-status',
      [...prNumbers].sort((a, b) => a - b).join(','),
      [...issueNumbers].sort((a, b) => a - b).join(','),
    ] as const,
  githubComments: (kind: 'issue' | 'pr', number: number) =>
    [queryScope(), 'github', 'comments', kind, number] as const,
  /** One issue/PR by number (`GET /api/github/items/…`, #692). Scoped, so the same number in two
   *  projects is two entries — a task tab must never show another project's #5. */
  githubItem: (kind: 'issue' | 'pr', number: number) =>
    [queryScope(), 'github', 'item', kind, number] as const,
  /** Every ref-status batch of one project — `githubRefStatus`'s prefix, which a merge
   *  invalidates so that project's chips and tab glyphs reread the PR it merged. */
  githubRefStatusOf: (projectId: string) => [projectId, 'github', 'ref-status'] as const,
  /** A PR's changed files. Scoped, so the same number in two projects is two entries. */
  githubPrChanges: (number: number) => [queryScope(), 'github', 'pr-changes', number] as const,
  githubMergeState: (number: number) => [queryScope(), 'github', 'merge-state', number] as const,
  get openTargets() {
    return [queryScope(), 'open-targets'] as const
  },
}

/**
 * Workspace-level keys — deliberately NOT scope-led: there is one project registry no matter
 * which project is active, and the `/p/:projectId` route gate reads it while the scope is
 * still being decided, so a scope-dependent key would chase its own tail (mount provider →
 * scope changes → key changes → data gone → provider unmounts).
 */
export const workspaceQueryKeys = {
  models: (runner: string, profileId?: string | null) => profileId && profileId !== DEFAULT_AGENT_ACCOUNT_ID
    ? ['workspace', 'models', runner, profileId] as const
    : ['workspace', 'models', runner] as const,
  providerStatus: ['workspace', 'providers', 'status'] as const,
  projects: ['workspace', 'projects'] as const,
  /** The accounts a new GitHub repository may belong to — read only while the New project dialog
   *  is open. */
  githubOwners: ['workspace', 'github-owners'] as const,
  /** The cross-project task index behind ⌘K. Workspace-led for the same reason the registry is:
   *  it answers for every project at once, so no scope owns it. */
  runsIndex: RUNS_INDEX_QUERY_KEY,
  runsSearch: (q: string) => ['workspace', 'runs-search', q] as const,
  /** `~/.cezar/ui-state.json` via `GET/PUT /api/workspace/ui-state` (step 2.7) — cross-project
   *  GUI prefs, e.g. the sidebar's per-project collapse map (step 3.3), and — since step 3.5 —
   *  appearance + notifications, which describe the user rather than a repo. */
  uiState: ['workspace', 'ui-state'] as const,
  /** `~/.cezar/config.json`'s settings slice via `GET/PUT /api/workspace/config` (step 2.7):
   *  the global Resources knobs and the checkout root. */
  config: ['workspace', 'config'] as const,
  /** Agent accounts via `GET /api/v1/workspace/agent-profiles` (spec 2026-07-29-agent-profiles).
   *  Workspace-led like the registry: an account describes the machine, not a repo. */
  agentProfiles: ['workspace', 'agent-profiles'] as const,
  /** One account's auth state — a child of `agentProfiles`, so removing an account drops it too. */
  agentAccountStatus: (routeId: string) =>
    ['workspace', 'agent-profiles', 'status', routeId] as const,
  /** One directory listing from `GET /api/fs/browse` (step 4.2's folder picker). Keyed by the
   *  browsed path — `null` is the browse root, whose absolute location only the server knows.
   *  Not scope-led: there is one filesystem behind the workspace, not one per project. */
  fsBrowseRoot: ['workspace', 'fs-browse'] as const,
  fsBrowse: (path: string | null, showHidden = false) =>
    [...workspaceQueryKeys.fsBrowseRoot, path, showHidden] as const,
}
