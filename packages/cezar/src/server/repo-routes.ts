import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { Capabilities } from '@open-mercato/cezar-contract';
import { commitQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { deleteBranchesInputSchema, repoPullInputSchema } from '@open-mercato/cezar-contract/repo';
import { reclaimBodySchema, reclaimRunParamsSchema, repoBranchSchema } from '@open-mercato/cezar-contract/repo-requests';
import { openProjectInSchema } from '@open-mercato/cezar-contract/workspace';
import { loadConfig, resolveWorktreeRetention } from '../config.ts';
import type { Home } from '../home/home.ts';
import type { PreviewHost } from '../preview/host.ts';
import { isReclaimable, reclaimWorktree, reclaimWorktrees, selectReclaimableWorktrees } from '../runs/retention.ts';
import { COMMIT_FORMATS, negotiate } from './accept-negotiation.ts';
import { memoizeRead } from './bounded-read-cache.ts';
import type { ForgeFactory } from './forge/index.ts';
import { getCommit, getDiff, getRepoInfo, getStatus } from './git.ts';
import { collectChanges, collectCommitChanges, createOrSwitchBranch } from './git-changes.ts';
import { agentCliRunner, detectOpenTargets, type openInApp } from './open-in-app.ts';
import { createGithubBranchForge } from './repo-branch-forge.ts';
import {
  classifyInputFor,
  deleteBranches,
  forgetRepoBranches,
  readRepoBranchCounts,
  readRepoBranches,
  type BranchForge,
  type ClassifyProject,
} from './repo-branches.ts';
import { claimRepoGitMutation, localPullBranches, pullRepoCheckout } from './repo-pull.ts';
import { forgetRepoRead, readRepoRefs } from './repo-read-cache.ts';
import { reclaimCheckoutError, runCheckout } from './run-checkout.ts';
import type { ProjectApiEnv } from './server-types.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { cachedWorktreeSizeBytes } from './worktree-size-cache.ts';

export interface OpenTargetsRouteDeps {
  capabilities: () => Capabilities;
  openApp: typeof openInApp;
}

export function createOpenTargetsRoutes(deps: OpenTargetsRouteDeps) {
  const { capabilities, openApp } = deps;
  return new Hono<ProjectApiEnv>()
    .get('/open-targets', (c) => c.json({ targets: capabilities().localHandoff ? detectOpenTargets() : [] }))

    .post('/open-in', jsonZodValidator(openProjectInSchema), async (c) => {
      const { root } = c.get('project');
      if (!capabilities().localHandoff) {
        return c.json(
          { error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' },
          409,
        );
      }
      const { target } = c.req.valid('json');
      if (agentCliRunner(target) !== null) {
        return c.json({ error: 'agent CLIs open a task worktree, not the project folder' }, 400);
      }
      if (!detectOpenTargets().some((candidate) => candidate.id === target)) {
        return c.json({ error: `no such app on this machine: ${target}` }, 400);
      }
      const opened = await openApp(target, root);
      if (!opened) return c.json({ error: `could not open ${target}`, path: root }, 409);
      return c.json({ opened: true as const, path: root });
    });
}

export interface WorktreesRouteDeps {
  home: Home;
  previewHost?: PreviewHost | undefined;
}

export function createWorktreesRoutes(deps: WorktreesRouteDeps) {
  return new Hono<ProjectApiEnv>()
    .get('/worktrees', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const keep = await resolveWorktreeRetention(repoRoot, deps.home);
      const withWorktree = store.queries.listRunsWithWorktree();
      const runs = withWorktree.filter((r) => r.worktreePath && existsSync(r.worktreePath));
      const getRun = memoizeRead((id) => store.getRun(id));
      const workersOf = memoizeRead((id) => store.queries.listWorkersOf(id));
      const pastKeep = new Set(selectReclaimableWorktrees(withWorktree, keep, getRun, workersOf));
      const worktrees = await Promise.all(
        runs.map(async (r) => ({
          runId: r.id,
          title: r.title ?? r.id,
          status: r.status,
          branch: r.branch ?? null,
          sizeBytes: await cachedWorktreeSizeBytes(r.worktreePath as string),
          finishedAt: r.finishedAt ?? null,
          reclaimable: isReclaimable(r, getRun, workersOf),
          pastKeep: pastKeep.has(r.id),
        })),
      );
      const totalBytes = worktrees.some((w) => w.sizeBytes === null)
        ? null
        : worktrees.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0);
      return c.json({ worktrees, totalBytes, keep });
    })

    .post('/worktrees/reclaim', jsonZodValidator(() => reclaimBodySchema, { absent: ({}), message: 'invalid body' }), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const reclaimed = await reclaimWorktrees(repoRoot, store, await resolveWorktreeRetention(repoRoot, deps.home), {
        claim: (run) => manager.claimWorktreeReclaim(run.id),
        previewHost: deps.previewHost,
      });
      if (reclaimed.length > 0) {
        forgetRepoBranches(repoRoot);
        forgetRepoRead(repoRoot);
      }
      return c.json({ reclaimed });
    })

    .post('/worktrees/:runId/reclaim', paramZodValidator(reclaimRunParamsSchema), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const checkout = runCheckout(c.get('project'), c.req.valid('param').runId, 'remove', {
        claim: 'reclaim',
        checksActive: false,
        deletion: 'inline',
        nullClaimError: 'this worktree is in use or already reclaimed — only a finished task\'s worktree can be reclaimed',
      });
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { run, release } = checkout;
      const worktreeReclaimedAt = await reclaimWorktree(repoRoot, store, run, { previewHost: deps.previewHost }).finally(release);
      if (!worktreeReclaimedAt) {
        return c.json({ error: await reclaimCheckoutError(run) }, 409);
      }
      forgetRepoBranches(repoRoot);
      forgetRepoRead(repoRoot);
      return c.json({ runId: run.id, worktreeReclaimedAt });
    });
}

export interface RepoRouteDeps {
  home: Home;
  forgeFactory?: ForgeFactory | undefined;
  branchForge?: BranchForge | undefined;
}

export function createRepoRoutes(deps: RepoRouteDeps) {
  const branchForge = deps.branchForge ?? createGithubBranchForge({ forgeFactory: deps.forgeFactory });
  const branchClassifyInput = (project: Omit<ClassifyProject, 'home'>) =>
    classifyInputFor({ ...project, home: deps.home }, branchForge);

  return new Hono<ProjectApiEnv>()
    .get('/repo', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) {
        return c.json({
          info: null,
          status: [],
          log: [],
          branches: [],
          baseBranch: null,
          tracking: null,
        });
      }

      const [status, config] = await Promise.all([
        getStatus(info.root),
        loadConfig(repoRoot, deps.home),
      ]);
      const refs = await readRepoRefs(info, config.baseBranch, store.queries);
      return c.json({
        info,
        status,
        log: refs.log,
        branches: refs.branches,
        baseBranch: config.baseBranch ?? null,
        tracking: refs.tracking,
      });
    })

    .get('/repo/branches', async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ base: '', prStateKnown: false, branches: [], counts: { notLanded: 0, cleanup: 0 } });
      return c.json(await readRepoBranches(input));
    })

    .get('/repo/branches/counts', async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ base: '', prStateKnown: false, counts: { notLanded: 0, cleanup: 0 }, allBranches: 0 });
      return c.json(await readRepoBranchCounts(input));
    })

    .post('/repo/branches/delete', jsonZodValidator(deleteBranchesInputSchema), async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ error: 'not a git repository', refused: [] }, 409);
      const body = c.req.valid('json');
      const release = claimRepoGitMutation(input.root);
      if (!release) return c.json({ error: 'a branch switch or pull is running — try again when it finishes', refused: [] }, 409);
      const result = await deleteBranches(input, body.names, body.confirm).finally(release);
      forgetRepoRead(input.root);
      if (result.deleted.length === 0) {
        return c.json({ error: result.refused[0]?.reason ?? 'nothing was deleted', refused: result.refused }, 409);
      }
      return c.json(result, 200);
    })

    .get('/repo/diff', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.text('not a git repository');
      return c.text(await getDiff(info.root));
    })

    .get('/repo/commit/:sha', queryZodValidator(commitQuerySchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      c.header('vary', 'Accept');
      const { structured } = c.req.valid('query');
      const wantsJson =
        structured !== undefined
          ? structured === '1'
          : negotiate(c.req.header('accept'), COMMIT_FORMATS) === 'application/json';
      const info = await getRepoInfo(repoRoot);
      if (wantsJson) {
        if (!info) return c.json({ error: 'not a git repository' }, 409);
        const result = await collectCommitChanges(info.root, c.req.param('sha'));
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json(result.commit);
      }
      if (!info) return c.text('not a git repository');
      try {
        return c.text(await getCommit(info.root, c.req.param('sha')));
      } catch (err) {
        return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    })

    .get('/repo/changes', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const result = await collectChanges(info.root, 'HEAD', {
        intentToAdd: false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    .get('/repo/pull', async (c) => {
      const { root } = c.get('project');
      const result = await localPullBranches(root);
      if ('error' in result) return c.json(result, 409);
      return c.json(result);
    })

    .post('/repo/pull', jsonZodValidator(repoPullInputSchema), async (c) => {
      const { root, store, manager } = c.get('project');
      const info = await getRepoInfo(root);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const config = await loadConfig(root, deps.home);
      const result = await pullRepoCheckout(
        info.root,
        c.req.valid('json'),
        config.baseBranch,
        () => store.queries.listRunIds().some((id) => manager.isActive(id)),
      );
      forgetRepoRead(info.root);
      if (!result.ok) return c.json(result.value, 409);
      return c.json(result.value, 200);
    })

    .post('/repo/branch', jsonZodValidator(() => repoBranchSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const release = claimRepoGitMutation(info.root);
      if (!release) return c.json({ error: 'A Git operation is already in progress for this repository.' }, 409);
      try {
        const input = c.req.valid('json');
        const result = await createOrSwitchBranch(info.root, input.name, input.from);
        forgetRepoBranches(info.root);
        forgetRepoRead(info.root);
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json({ branch: result.branch, created: result.created });
      } finally {
        release();
      }
    });
}
