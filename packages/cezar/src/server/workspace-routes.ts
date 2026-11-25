import { stat } from 'node:fs/promises';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RunSummary, RunsSearchResponse, WorkspaceConfigResponse } from '@open-mercato/cezar-contract';
import { browseQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { refNumberFromUrl, searchTokens } from '@open-mercato/cezar-contract/run-search';
import { RUNS_SEARCH_PER_PROJECT_MAX, runsSearchQuerySchema, type RunIndexEntry } from '@open-mercato/cezar-contract/runs';
import { setWorkspaceConfigInputSchema as workspaceConfigUpdateSchema, setWorkspaceUiStateInputSchema } from '@open-mercato/cezar-contract/workspace';
import { workspaceEventsQuerySchema, type RunsIndexResponse } from '@open-mercato/cezar-contract/workspace-events';
import { resolveGlobalArchiveOnMerge } from '../archive-on-merge-setting.ts';
import { isAbsoluteHostPath } from '../core/host-path.ts';
import { productEnv } from '../core/product-env.ts';
import type { Home } from '../home/home.ts';
import { expandTilde } from '../paths.ts';
import { projectPaths } from '../project-paths.ts';
import { REMOVED_RUNNER_IDS } from '../runs/legacy-run-rows.ts';
import { ARCHIVED_WINDOW, readRunIndexFromDisk, searchRunIndexFromDisk } from '../runs/run-index.ts';
import type { RepoHandle, RunStore } from '../runs/store.ts';
import {
  effectiveComposerDefault,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  type WorkspaceConfig,
} from '../workspace/config.ts';
import type { ProjectListEntry } from '../workspace/projects.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { mergeWriteWorkspaceUiState, readWorkspaceUiState } from '../workspace/ui-state.ts';
import { projectAdmissionRefusal } from './cockpit-ownership.ts';
import { ColdRepoHandles } from './cold-repo-handles.ts';
import { resolveForgeRoot, type ForgeFactory } from './forge/index.ts';
import { browseDirectory, resolveBrowseRoot } from './fs-browse.ts';
import { probeWritableDir } from './probe-writable-dir.ts';
import type { ProjectContext, ProjectContexts } from './project-context.ts';
import {
  streamSSENoBuffer,
  UI_STATE_BODY_LIMIT,
  type ProjectApiEnv,
  type WorkspaceEventBus,
} from './server-types.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import { applyWorkspaceConfigPatch } from './workspace-config-patch.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';
import type { createWorkspaceRunFeed } from './workspace-run-feed.ts';

export interface WorkspaceConfigRouteDeps {
  home: Home;
  semaphore?: WorkspaceSemaphore | undefined;
  archiveOnMergeChanged?: (() => void) | undefined;
}

export function createWorkspaceConfigRoutes(deps: WorkspaceConfigRouteDeps) {
  const { home } = deps;

  const workspaceConfigBody = (config: WorkspaceConfig): WorkspaceConfigResponse => ({
    browseRoot: config.browseRoot,
    projectsDir: config.projectsDir,
    archiveOnMerge: config.archiveOnMerge ?? null,
    effectiveArchiveOnMerge: resolveGlobalArchiveOnMerge(config).enabled,
    archiveOnMergeSource: resolveGlobalArchiveOnMerge(config).source,
    composerDefaults: {
      autonomous: config.composerDefaults.autonomous ?? null,
      worktree: config.composerDefaults.worktree ?? null,
      inheritedAutonomous:
        productEnv('AUTONOMOUS_DEFAULT') === '0'
          ? false
          : productEnv('AUTONOMOUS_DEFAULT') === '1'
            ? true
            : 'source-dependent',
      inheritedWorktree: effectiveComposerDefault(
        undefined,
        productEnv('WORKTREE_DEFAULT'),
        true,
      ),
    },
    resources: {
      maxParallel: config.resources.maxParallel,
      maxMonitoringSessions: config.resources.maxMonitoringSessions,
      monitoringWakeIntervalMinutes: config.resources.monitoringWakeIntervalMinutes,
      autoResumeOnUsageLimit: config.resources.autoResumeOnUsageLimit,
      memoryLimitMb: config.resources.memoryLimitMb,
      worktreeRetentionDefault: config.resources.worktreeRetentionDefault,
    },
    agentDefaults: {
      ...(config.agentDefaults.runner !== undefined ? { runner: config.agentDefaults.runner } : {}),
      ...(config.agentDefaults.models !== undefined ? { models: config.agentDefaults.models } : {}),
    },
  });

  return new Hono<ProjectApiEnv>()
    .get('/workspace/config', async (c) => c.json(workspaceConfigBody(await loadWorkspaceConfig(home.workspaceConfig))))

    .put('/workspace/config', jsonZodValidator(() => workspaceConfigUpdateSchema, { runners: { ids: ['agentDefaults.runner'], keys: ['agentDefaults.models'] } }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const { browseRoot, projectsDir, archiveOnMerge, resources } = parsed.data;
      for (const [configuredRoot, create] of [
        [browseRoot, false],
        [projectsDir, true],
      ] as const) {
        if (configuredRoot === undefined) continue;
        const expanded = expandTilde(configuredRoot);
        if (!isAbsoluteHostPath(expanded)) return c.json({ error: `not writable: ${configuredRoot} is not an absolute path` }, 400);
        if (!create) {
          try {
            if (!(await stat(expanded)).isDirectory()) {
              return c.json({ error: `browse folder is not a directory: ${configuredRoot}` }, 400);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return c.json({ error: `browse folder does not exist: ${configuredRoot}` }, 400);
            }
            return c.json({ error: `browse folder unavailable: ${err instanceof Error ? err.message : String(err)}` }, 400);
          }
        }
        const probeError = await probeWritableDir(expanded, create);
        if (probeError !== null) return c.json({ error: `not writable: ${probeError}` }, 400);
      }
      let written: WorkspaceConfig;
      try {
        written = await mergeWriteWorkspaceConfig((config) => {
          applyWorkspaceConfigPatch(config, parsed.data);
        }, home);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (archiveOnMerge !== undefined) deps.archiveOnMergeChanged?.();
      if (resources !== undefined) await deps.semaphore?.refresh();
      return c.json(workspaceConfigBody(written));
    })

    .get('/workspace/ui-state', async (c) => c.json(await readWorkspaceUiState(home.workspaceUiState, home)))

    .use('/workspace/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/workspace/ui-state', jsonZodValidator(setWorkspaceUiStateInputSchema, { runners: { strictKeys: { path: 'dismissedProviderAuthFailures', also: REMOVED_RUNNER_IDS } } }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      try {
        return c.json(
          await mergeWriteWorkspaceUiState((state) => ({
            ...state,
            ...parsed.data,
          }), home),
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
}

export function createFsBrowseRoutes(workspaceBrowseRoot: () => Promise<string>) {
  return new Hono<ProjectApiEnv>()
    .get(
      '/fs/browse',
      queryZodValidator(browseQuerySchema),
      async (c) => {
        const query = c.req.valid('query');
        const root = resolveBrowseRoot(await workspaceBrowseRoot());
        const result = await browseDirectory({
          root,
          path: query.path,
          showHidden: query.showHidden === '1',
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.body);
      },
    );
}

export interface WorkspaceEventsRouteDeps {
  serverGeneration: string;
  resolveBootProject: WorkspaceProjects['resolveBootProject'];
  workspaceRunFeed: ReturnType<typeof createWorkspaceRunFeed>;
  workspaceEvents: WorkspaceEventBus;
}

export function createWorkspaceEventsRoutes(deps: WorkspaceEventsRouteDeps) {
  const { serverGeneration, resolveBootProject, workspaceRunFeed, workspaceEvents } = deps;
  return new Hono<ProjectApiEnv>()
    .get('/workspace/events', queryZodValidator(workspaceEventsQuerySchema), (c) => {
      const mode = c.req.valid('query').runs === 'summary' ? 'summary' : 'full';
      return streamSSENoBuffer(c, async (stream) => {
        const bootProject = await resolveBootProject();
        const detach = workspaceRunFeed.connect(bootProject, mode, (event, data) => void stream.writeSSE({ event, data }));
        const offWorkspace = workspaceEvents.on((event, data) => {
          void stream.writeSSE({ event, data: JSON.stringify(data) });
        });

        stream.onAbort(() => {
          detach();
          offWorkspace();
        });

        await stream.writeSSE({
          event: 'ready',
          data: JSON.stringify(mode === 'summary' ? { generation: serverGeneration, seq: workspaceRunFeed.seq() } : { generation: serverGeneration }),
        });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });
}

export interface RunsIndexRouteDeps {
  loadPreparedProjects: (projects: ProjectListEntry[]) => Promise<ProjectListEntry[]>;
  forgeFactory?: ForgeFactory | undefined;
  bootContext: ProjectContext;
  contexts: ProjectContexts;
  workspaceProjects: WorkspaceProjects;
  workspaceRunFeed: ReturnType<typeof createWorkspaceRunFeed>;
  serverGeneration: string;
  withLiveUsage: (summary: RunSummary) => RunSummary;
}

const RUNS_INDEX_PER_PROJECT = ARCHIVED_WINDOW;

function mentionedReferenceNumbers(run: RunSummary): number[] {
  const numbers: number[] = (run.pullRequests ?? []).map(pr => pr.number);
  for (const url of [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl]) {
    const number = url ? refNumberFromUrl(url) : null;
    if (number !== null) numbers.push(number);
  }
  for (const number of [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue]) {
    if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.push(number);
  }
  return numbers;
}

export function createRunsIndexRoutes(deps: RunsIndexRouteDeps) {
  const {
    loadPreparedProjects,
    forgeFactory,
    bootContext,
    contexts,
    workspaceProjects,
    workspaceRunFeed,
    serverGeneration,
    withLiveUsage,
  } = deps;
  const { resolveBootProject } = workspaceProjects;
  const coldRepoHandles = new ColdRepoHandles(forgeFactory);

  const projectRunSources = async (): Promise<Array<{
    project: ProjectListEntry; store: RunStore | undefined; dataDir: string; handle: RepoHandle | null | undefined;
  }>> => {
    let projects: ProjectListEntry[] = [];
    try {
      projects = await workspaceProjects.listProjects();
    } catch {
      // unreadable workspace — no rows, never a 500
    }
    const bootId = await resolveBootProject(projects);
    coldRepoHandles.retainRoots(new Set(projects
      .filter((project) => project.status !== 'missing' && project.id !== bootId && !contexts.peek(project.id))
      .map((project) => project.root)));
    return (await loadPreparedProjects(projects)).filter((project) => project.status !== 'missing' && !projectAdmissionRefusal(projectPaths(project.root).write)).map((project) => {
      const owned = project.id === bootId ? bootContext : contexts.peek(project.id);
      return { project, store: owned?.store, dataDir: projectPaths(project.root).write, handle: owned ? undefined : coldRepoHandles.get(project.root) };
    });
  };

  const readProjectRuns = (projectId: string, read: () => { runs: RunSummary[]; truncated: boolean }) => {
    try {
      return read();
    } catch (error) {
      console.warn(`[hsq] runs of project ${projectId} could not be read for the workspace run index: ${error instanceof Error ? error.message : String(error)}`);
      return { runs: [], truncated: false };
    }
  };

  return new Hono()
    .get('/workspace/runs-index', async (c) => {
      const runs: RunIndexEntry[] = [];
      const truncated: string[] = [];
      const referenceStatuses: RunsIndexResponse['referenceStatuses'] = {};
      const sources = await projectRunSources();
      const eventSeq = workspaceRunFeed.seq();
      for (const { project, store: owned, dataDir, handle } of sources) {
        const window = readProjectRuns(project.id, () => owned
          ? owned.queries.listRunSummaries({ archivedWindow: RUNS_INDEX_PER_PROJECT, roots: true })
          : readRunIndexFromDisk(dataDir, { handle, archivedWindow: RUNS_INDEX_PER_PROJECT, roots: true }));
        if (window.truncated) truncated.push(project.id);
        const recent = window.runs.map(withLiveUsage);
        const mentioned: number[] = [];
        for (const run of recent) {
          runs.push({ projectId: project.id, ...run });
          mentioned.push(...mentionedReferenceNumbers(run));
        }
        if (mentioned.length > 0) {
          const cached = resolveForgeRoot(project.root, forgeFactory).cachedRefStatuses(mentioned);
          if (Object.keys(cached.prs).length > 0 || Object.keys(cached.issues).length > 0) {
            referenceStatuses[project.id] = cached;
          }
        }
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const body: RunsIndexResponse = {
        runs,
        perProjectLimit: RUNS_INDEX_PER_PROJECT,
        truncated,
        referenceStatuses,
        generation: serverGeneration,
        eventSeq,
      };
      return c.json(body);
    })
    .get('/workspace/runs-search', queryZodValidator(runsSearchQuerySchema), async (c) => {
      const { q, limit = RUNS_SEARCH_PER_PROJECT_MAX } = c.req.valid('query');
      const runs: RunIndexEntry[] = [];
      const truncated: string[] = [];
      const tokens = searchTokens(q);
      for (const { project, store: owned, dataDir, handle } of await projectRunSources()) {
        const name = project.name.toLowerCase();
        const rest = tokens.filter((token) => !name.includes(token));
        if (rest.length === 0) continue;
        const scoped = rest.join(' ');
        const found = readProjectRuns(project.id, () => owned ? owned.queries.searchRunSummaries(scoped, limit) : searchRunIndexFromDisk(dataDir, scoped, { handle, limit }));
        if (found.truncated) truncated.push(project.id);
        for (const run of found.runs) runs.push({ projectId: project.id, ...withLiveUsage(run) });
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const body: RunsSearchResponse = { runs, truncated };
      return c.json(body);
    });
}
