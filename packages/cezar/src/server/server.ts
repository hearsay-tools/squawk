import type { RunnerSkillCatalog } from '../core/runner-skill-catalog.ts';
import { runCheckout, preparePublishCheckout } from './run-checkout.ts';
import { adoptFallbackControl, protectFallbackRun, runArtifactDirectory } from './project-run-files.ts';
import { projectPaths, fallbackProjectWriteError } from '../project-paths.ts';
import { reportsRoutes } from './reports-api.ts';
import { queuedMessagePatchSchema, continueSchema, archiveSchema, openInSchema } from '@open-mercato/cezar-contract/run-requests';
import { worktreeFilesQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { gitCommitSchema } from '@open-mercato/cezar-contract/repo-requests';
import { patchRunInputSchema as patchRunSchema, messageInputSchema as messageSchema } from '@open-mercato/cezar-contract/runs';
import { imageMimeType } from '@open-mercato/cezar-contract/image-path';
import { providerForActiveRun } from '@open-mercato/cezar-contract/active-provider';
import { removedRunnerMessage } from '@open-mercato/cezar-contract/runner';
export type { WorkspaceConfigResponse } from '@open-mercato/cezar-contract';
import { permissionDecisionSchema } from '@open-mercato/cezar-contract/permissions';
import { runIdParamSchema as permissionRunIdParamSchema } from '@open-mercato/cezar-contract/events';
import { CheckoutProgressCache } from './checkout-progress.ts';
import { createWorkspaceLiveRoutes } from './workspace-live-routes.ts';
import { createActivityRoutes, type ActivityServerDeps } from './activity-routes.ts';
import { createRunnersRoutes } from './runners-routes.ts';
import type { Home } from '../home/home.ts';
import { createWorkspaceProjects, createWorkspaceProjectContexts, createTaskWebhooks, type WorkspaceProjects } from './workspace-projects.ts';
import type { ApiRun, ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-contract';
import { latestSession } from '@open-mercato/cezar-contract/run-predicates';
import { ARCHIVED_RUNS_PAGE_DEFAULT } from '@open-mercato/cezar-contract/run-limits';
import { archivedRunsQuerySchema, createRunInputSchema, runSummariesQuerySchema } from '@open-mercato/cezar-contract/runs';
import { DelegationService, type WorkerCleanupFactory } from '../delegation/service.ts';
import { runRelationships } from './run-relationships.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { delegationFailure } from '../delegation/routes.ts';
import { workerDestroyRequestSchema, workerEmptyRequestSchema, runRelationshipsSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../automations/store.ts';
import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { matchedRoutes } from 'hono/route';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { TaskWebhooks } from '../runs/webhook.ts';
import { pinRunInputSchema, archiveFinishedRequestSchema, markAllReadRequestSchema, notifyRunInputSchema } from '@open-mercato/cezar-contract/runs';
// A contract VALUE, like `workspaceUiStateSchema` in workspace/migrations.ts — the request
// schema this route validates with is the same one the client compiles against.
import { registeredRunnerId, registeredRunners, resolveRunnerId, runnerDefinition } from '../core/runner-registry.ts';
import {
  attachmentFileParamSchema,
} from '@open-mercato/cezar-contract/runs';
import { taskWebhooks as taskWebhookList } from '../workspace/webhooks.ts';
import { environmentStamp, type detectEnvironment } from '../core/backend-detect.ts';
import type { ContentBlock } from '../core/agent-runner.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { createModelsRoutes } from './models-routes.ts';
import { createProviderSignInRoutes } from './provider-sign-in-routes.ts';
import { allUsage, currentUsage, onUsage } from '../core/process-usage.ts';
import { readHandoff, renderHandoffRecords } from '../handoff.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { HistoryCursorError, deriveRunContextEvents, readRunHistoryPage } from '../runs/event-history.ts';
import { ARCHIVED_WINDOW } from '../runs/run-index.ts';
import { ownPullRequestNumbers } from '../runs/pull-requests.ts';
import { runHistoryQuerySchema, runIdParamSchema } from '@open-mercato/cezar-contract/events';
import { resolveAttachmentPathAsync } from '../workflows/attachment-path.ts';
import { artifactParamsSchema, fileLinkQuerySchema } from '@open-mercato/cezar-contract/artifacts';
import { listArtifacts, readArtifact, readArtifactMetadata } from '../artifacts/store.ts';
import { artifactPreview, loadFileLink, rasterMime } from '../artifacts/resolve.ts';
import { toPastedContent, type PastedContent } from '../workflows/pasted-content.ts';
import { isUntouchedCancelledRun } from '../workflows/run/run-guards.ts';
import { worktreeDiff } from '../git-worktree.ts';
import { releaseThenRemoveWorktree } from '../git-worktree-release.ts';
import { getRepoInfo, type RepoInfo } from './git.ts';
import { createHealthCache, HEALTH_TTL_MS } from './health-cache.ts';
import { FILE_FORMATS, negotiate } from './accept-negotiation.ts';
import { authorityOfHost, authorityOfOrigin, hostnameOfHost, hostnameOfOrigin } from './host-authority.ts';
import { pluginHealth, pluginLoadReport } from '../plugin/loader.ts';
import { createBackendChecks } from './backend-checks.ts';
import { type BranchForge } from './repo-branches.ts';
import { collectChanges, collectCommitChanges, collectRunCommits, commitAll, pushCurrentBranch, readWorktreePath } from './git-changes.ts';
import { healthConfig, loadConfig } from '../config.ts';
import { defaultWorkspaceConfig, loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, defaultAgentAccountStore, loadAgentAccounts, type AgentAccount } from '../workspace/agent-accounts.ts';
import { defaultAgentProfile, listAgentProfiles, resolveStoredProfile, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { profileEnv } from '../core/agent-profiles.ts';
import { shellQuote, withEnvPrefix } from '../core/shell-env.ts';
import { resumeCommand } from '../core/runner-cli.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { type CloneRunner } from './checkout.ts';
import { type CommandRunner } from './create-project.ts';
import { createWorkspaceRunFeed } from './workspace-run-feed.ts';
import { ProjectContexts, type ProjectContext, type ProjectRunManager, type RunManagerFactory } from './project-context.ts';

import { isLoopbackHostHeader, resolveCapabilities } from './capabilities.ts';
import type { SocketHub, WsUpgradeVerdict } from './ws.ts';
import type { PreviewHost } from '../preview/host.ts';
import { resolveForge, forgeWebRoot, resolveForgeRoot, type ForgeFactory } from './forge/index.ts';
import { withProjectAdmission, type CockpitOwnership } from './cockpit-ownership.ts';
import { prepareProjects } from '../project-migration/auto.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { freshCliHandoff, openRunApp, openRunCli, openRunDefaultApp } from './open-in-targets.ts';
import { agentCliRunner, openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import { continueRunProviders } from './provider-action-gate.ts';
import { attachProjectWebhooks, createBootContext, createProviderStatus, resolveServerDeps, watchProviderRuntimeAuth } from './server-deps.ts';
import {
  NO_WEBHOOK_ERROR,
  agentProfileRefusal,
  clientRequestOf,
  launchRun,
  modelLockRefusal,
  notifyRefusal,
  providerGateRefusal,
  replayedRun,
  resolveStartWorkflow,
  startRunInput,
} from './start-run-options.ts';
import {
  ASSET_CACHE_CONTROL,
  BUILD_HINT_HTML,
  assetContentType,
  isSafeAssetFilename,
  resolveGetRequest,
} from './static-ui.ts';
import { compression, createStaticAssets, isFile } from './static-assets.ts';
import { registerBrandFileRoutes } from './brand-file-routes.ts';
import { createProjectsRoutes } from './projects-routes.ts';
import { createAgentProfilesRoutes, createProvidersRoutes } from './providers-routes.ts';
import { hostedProfileRefusal, WorkspaceEventBus, type ProjectApiEnv } from './server-types.ts';
import { createAutomationsRouteBundles } from './automations-routes.ts';
import { createGithubRoutes } from './github-routes.ts';
import { createOpenTargetsRoutes, createRepoRoutes, createWorktreesRoutes } from './repo-routes.ts';
import { createFsBrowseRoutes, createRunsIndexRoutes, createWorkspaceConfigRoutes, createWorkspaceEventsRoutes } from './workspace-routes.ts';
import { createAgentConfigRoutes, createAgentWebhooksRoutes, createConfigRoutes, createPlanRoutes, createSkillsRoutes, createSseRoutes, createUiStateRoutes, createWorkflowsRoutes } from './project-settings-routes.ts';
export interface ServerDeps extends ActivityServerDeps {
  home: Home;
  /** Per-repository forge injection for embedded servers and tests. */
  forgeFactory?: ForgeFactory;
  /** CLI lifetime ownership, shared with secondary project contexts. */
  ownership?: CockpitOwnership;
  /** The task-webhook subscribers (#589). Boot creates it and attaches the boot store BEFORE
   *  `manager.recover()`, so recovery's transitions are reported; `startServer` sets its origin
   *  from the port it binds. Absent (tests, embedded apps), `createApp` makes its own. */
  taskWebhooks?: TaskWebhooks;
  /** Test seam for task-webhook deliveries (#589): the `fetch` they POST with. Used only when
   *  `createApp` builds its own `TaskWebhooks`. */
  taskWebhookFetch?: typeof fetch;
  /** Same-process optional private listener; attached to managers before recovery. Without it, `workerCleanup` lets the fallback service destroy workers. */
  delegation?: DelegationController; workerCleanup?: WorkerCleanupFactory;
  repoRoot: string;
  store: RunStore;
  manager: ProjectRunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
  /** Host the HTTP server binds (default 127.0.0.1). A non-loopback host
   *  implies hosted mode — `capabilities.localHandoff:false`. */
  bindHost?: string | undefined;
  /** Workspace-registry id of the boot project (multi-project spec) — plumbed
   *  from `initWorkspace` in src/index.ts. Optional: legacy callers/tests get
   *  a lazy registry lookup by `repoRoot`, falling back to the repo's slug. */
  bootProjectId?: string | undefined;
  /** Per-project context map (multi-project spec, step 2.2). Non-boot
   *  `/api/p/:projectId/*` requests resolve their `{store, manager, …}` here,
   *  built lazily on first touch. Optional so legacy callers change nothing —
   *  the default is a registry-backed map; tests inject their own so they can
   *  `disposeAll()` after. The BOOT project never lives in this map: its
   *  context is seeded from `deps.{store,manager}` (which src/index.ts already
   *  recovered/pruned at startup) and the resolver short-circuits to it. */
  contexts?: ProjectContexts | undefined;
  /** Builds each non-boot project's manager for the default `contexts`; `serve` passes the real one. */
  createManager?: RunManagerFactory | undefined;
  /** Boot project's shared automation store. `startServer` injects the
   *  coordinator-owned instance so HTTP routes and the scheduler never cache
   *  separate views of the same project files. */
  automationStore?: AutomationStore | (() => AutomationStore);
  /** Workspace-wide parallel-cap semaphore + cached resource config (spec
   *  2026-07-20, step 2.5): the ONE instance boot created, refreshed, and gave
   *  the boot manager — threaded into the default `ProjectContexts` so every
   *  project's RunManager shares it. Step 2.7's `PUT /api/workspace/config`
   *  calls `semaphore.refresh()` after a write. Optional so legacy
   *  callers/tests change nothing. */
  semaphore?: WorkspaceSemaphore;
  /** Workspace-level SSE bus (spec, step 2.8): `project-added` /
   *  `project-removed` / `checkout-progress` plus the host-wide unstamped
   *  `provider-status` event reach `/api/workspace/events` through this.
   *  Optional — createApp builds a private one; inject to emit from outside
   *  the app (tests, future CLI hooks). */
  workspaceEvents?: WorkspaceEventBus | undefined;
  /** How `POST /api/projects/checkout` (step 4.3) actually clones. Defaults to
   *  `gh repo clone` (or the `CEZ_DRY_RUN=1` fake) — injected by tests so the
   *  route's guards, cleanup and error surfacing are exercised for real
   *  against real temp dirs, without a network or a `gh` binary. */
  cloneRunner?: CloneRunner;
  /** How `POST /api/v1/projects/create` and `GET /api/v1/projects/github-owners`
   *  run `git`/`gh` (spec 2026-10-15-create-new-project). Defaults to real
   *  commands (or the `CEZ_DRY_RUN=1` fake); injected by tests. */
  projectCommandRunner?: CommandRunner;
  /** What the Git view's branch classifier asks GitHub (issue 08). Defaults to the ref-status
   *  cache plus one cached `gh pr list`; tests inject a fake forge. */
  branchForge?: BranchForge;
  /** Host-wide model discovery service. Tests inject a deterministic adapter. */
  modelCatalog?: RunnerModelCatalog;
  skillCatalog?: RunnerSkillCatalog;
  /** Host-wide provider authentication discovery. Tests inject deterministic probes. */
  providerAuth?: ProviderAuthService;
  detectEnvironment?: typeof detectEnvironment; // Host CLI detection behind health's availability checks. Tests inject a fake.
  /** Global provider enablement preferences. Tests may inject an in-memory store. */
  workspaceConfig?: {
    load: (path?: string) => ReturnType<typeof loadWorkspaceConfig>;
    mergeWrite: (mutator: Parameters<typeof mergeWriteWorkspaceConfig>[0], home?: import('../home/home.ts').Home) => ReturnType<typeof mergeWriteWorkspaceConfig>;
  } | undefined;
  /** Shared runtime rejection observer. The CLI injects the instance already
   *  watching the boot store before recovery; createApp builds one for legacy
   *  callers and tests. */
  providerRuntimeAuth?: ProviderRuntimeAuthObserver;
  /** Local terminal handoff for provider-owned login. */
  openTerminal?: typeof openInTerminal | undefined;
  /** Hand a local FILE (or folder) to the OS default app. Injected so the open routes are
   *  testable without actually launching an editor. */
  openFile?: typeof openFileInDefaultApp;
  /** Hand a folder to a detected app by target id — editor, file manager, or `terminal`, which
   *  reaches `openInTerminal`. Injected for the same reason as the two above: a test that reaches
   *  this for real opens a window on the developer's machine (#820). */
  openApp?: typeof openInApp;
  /** WebSocket subscription hub (`/api/v1/ws`, src/server/ws.ts). `createApp`
   *  only registers topics on it — `startServer` builds one and attaches it
   *  to the HTTP server it binds. Optional so legacy callers/tests change
   *  nothing: no hub, no topics, and the HTTP surface is byte-identical. */
  socketHub?: SocketHub;
  /** The workspace-wide live preview host (#781), one per server process because ports are
   *  host-global. Present only under `CEZ_PREVIEW=1`; absent, the preview WebSocket answers 404
   *  and every run manager answers `headless`. */
  previewHost?: PreviewHost | undefined;
  /** The port the cockpit listens on, once it does: `cezar_preview_serve` refuses it. */
  squawkPort?: () => number | undefined;
  /** Shared workspace identity and upgrade lookup; direct createApp callers get a local instance. */
  workspaceProjects?: WorkspaceProjects;
  /** Re-arm the workspace automation timer after definition mutations. */
  automationsChanged?: () => void;
  archiveOnMergeChanged?: () => void;
}
// ---- project-scoped routing (multi-project spec, step 2.2) -----------------

export { WorkspaceEventBus, type ProjectApiEnv, type WorkspaceEventName } from './server-types.ts';
/** One row of the mirrored project-route table. */
export interface ProjectRouteInfo {
  method: string;
  /** Path relative to the mount — `/runs/:id`, not `/api/runs/:id`. */
  path: string;
}

/**
 * The public API surface (spec 2026-07-23-independent-server-web-packages).
 *
 * Every route lives under this one prefix. The unversioned `/api/*` spelling the cockpit used
 * to speak was removed once the whole API was reachable here — carrying two spellings meant two
 * surfaces to keep working, and only one of them could be the typed contract. Bumping to `v2`
 * means mounting a second table beside this one, not editing route paths.
 */
const V1_PREFIX = '/api/v1';

/** Project scoping inside the versioned surface. The version is the OUTER dimension, so a
 *  consumer picks its API version once and then addresses projects inside it. */
const V1_SCOPED_PREFIX = `${V1_PREFIX}/p/:projectId`;

/**
 * The project-scoped route table of a `createApp()` app, derived from its actual registrations
 * (so it can never drift from the code): every method+path mounted under
 * `/api/v1/p/:projectId/…`, minus the scope-resolver middleware (method ALL), deduped. The
 * alias-parity suite iterates this to assert `/api/v1/<path>` ≡ `/api/v1/p/<boot>/<path>` ≡
 * `/api/v1/p/default/<path>`.
 */
export function projectRouteManifest(app: Hono): ProjectRouteInfo[] {
  const seen = new Set<string>();
  const manifest: ProjectRouteInfo[] = [];
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith(`${V1_SCOPED_PREFIX}/`)) continue;
    const path = route.path.slice(V1_SCOPED_PREFIX.length);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    manifest.push({ method: route.method, path });
  }
  return manifest;
}

/** 409 body for every automations route while GitHub automations are off (#801). */

/** 404 body for a run whose row is in runs.db but whose record this Squawk cannot decode (#779). */
const UNREADABLE_RUN_ERROR = `this run could not be read by this Squawk: its record in runs.db does not fit this version (a newer Squawk may have written it). It is left in the database untouched.`;

// These response shapes belong to the contract; keep the server's existing type exports.
export type { ProjectsResponse, RegisterProjectResponse, RemoveProjectResponse, UpdateProjectResponse } from '@open-mercato/cezar-contract';

// ---- workspace SSE (multi-project spec, step 2.8) --------------------------


// Queued prompt stack bounds (#472). The per-message bounds mirror `messageSchema`
// above; the one that actually matters is the FOLDED total, because 20 messages of
// 100 000 chars each would otherwise compose a ~2 M-character {{task}}.
const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_ATTACHMENTS = 8;
const MAX_FOLDED_TASK_CHARS = 200_000;

/** Length of the prompt a run would execute with — `task` plus its whole stack,
 *  composed exactly as `hydrateQueuedInput` composes it. Checked against the
 *  PROSPECTIVE state so the user is stopped at the write, not at dequeue where
 *  there would be no one left to tell. */
function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

// Request-body size guards (#429). A generous global cap keeps a single
// localhost request from being unbounded (the largest legit body is 4 pasted
// images at ~7 MB base64 each); the ui-state PUT gets a much tighter cap since
// it only ever carries small GUI prefs.
const GLOBAL_BODY_LIMIT = 32 * 1024 * 1024; // 32 MiB
// The return type is INFERRED on purpose: it is the chained app type built at the bottom of
// this function, and `AppType` (src/server/app-type.ts) is `ReturnType<typeof createApp>`.
// Annotating it `Hono` here would erase every route from the type and leave the typed client
// with nothing to offer. See the `routed` assembly at the end of the function.
export function createApp(deps: ServerDeps) {
  const { version, update, bindHost, bootProjectId } = deps;
  const resolveProjectForge = (info: Awaited<ReturnType<typeof getRepoInfo>>) => resolveForge(info, deps.forgeFactory);
  // Boot singletons keep DELIBERATELY distinct names (`boot*`): every
  // project-scoped handler must resolve its `{store, manager, root, dataDir}`
  // from `c.get('project')` — a bare `store`/`repoRoot` in a
  // handler body would silently pin it to the boot project, which the rename
  // turns into a compile error instead.
  const bootRoot = deps.repoRoot;
  const bootDataDir = projectPaths(bootRoot).write;
  // The host-wide services and the provider closures built on them live in `./server-deps.ts`.
  const { skillCatalog, modelCatalog, providerAuth, workspaceConfig, openTerminal, openFile, openApp, detectEnvironment } = resolveServerDeps(deps, bootRoot);
  const { providerStatus, providerActionError, invalidateHostModels } =
    createProviderStatus({ modelCatalog, providerAuth, workspaceConfig }, deps.home);

  const workspaceProjects = deps.workspaceProjects ?? createWorkspaceProjects({ bootRoot, bootProjectId, home: deps.home });
  const { resolveBootProject } = workspaceProjects;
  // Health's workspace garnish: id+name ONLY — never `root` (#431, see the
  // health route). Reads only the registry file; no per-root status probes,
  // so health stays cheap.
  const workspaceSummary = async (): Promise<{
    projects: { id: string; name: string }[];
    bootProject: string;
  }> => {
    try {
      const registry = (await loadWorkspaceConfig(deps.home.workspaceConfig)).projects;
      const bootProject = await resolveBootProject(registry);
      return {
        // Explicit picks, not a spread: the registry schema passes unknown
        // keys through, and `root` must never ride along onto health.
        projects: registry.map((p) => ({
          id: p.id,
          name: p.name || basename(p.root),
        })),
        bootProject,
      };
    } catch {
      return { projects: [], bootProject: await resolveBootProject([]) };
    }
  };
  // Hosted-mode gate (spec §"Deployment modes") — read per request so
  // CEZ_REMOTE flips take effect live (and tests can toggle it).
  const capabilities = () => resolveCapabilities(process.env, bindHost, deps.squawkPort?.(), deps.home);
  // Inbox live updates (spec 007). Opt-in (#471): no capability, no watcher —
  // and since step 2.3 the per-dataDir watch is created lazily by the first
  // SSE subscription (and torn down with the last), nothing to start here.

  // ---- project contexts (multi-project spec, step 2.2) ---------------------
  // The boot project's context is SEEDED from the deps the caller already built (`createBootContext`).
  const bootContext: ProjectContext = createBootContext(deps, bootRoot, bootDataDir);
  // The task webhook (#589): attached before any recovery — the boot store by `index.ts`, lazy
  // projects through `prepareManager` below. Attaching is idempotent, so the calls here only
  // cover an app built without boot's wiring (tests, embedded servers).
  const taskWebhooks = createTaskWebhooks(deps, '');
  taskWebhooks.attach(bootContext);
  // Non-boot projects build lazily on first scoped request; their managers
  // count against the same workspace semaphore as the boot manager (step 2.5).
  const contexts = createWorkspaceProjectContexts(deps, taskWebhooks, {
    listProjects: () => workspaceProjects.listProjects(),
    squawkPort: deps.squawkPort,
  });
  // Workspace-level SSE bus (step 2.8) — the registry mutators and the
  // checkout flow (Phase 4) emit here; /api/workspace/events relays.
  const serverGeneration = randomUUID();
  const checkoutProgress = new CheckoutProgressCache();
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const automationsChanged = () => deps.automationsChanged?.();

  const providerRuntimeAuth = deps.providerRuntimeAuth
    ?? new ProviderRuntimeAuthObserver(providerAuth, (status) => {
      workspaceEvents.emit('provider-status', status);
    }, undefined, deps.home);
  const attachSkillCatalog = (project: ProjectContext) => project.manager?.setSkillCatalog?.(skillCatalog);
  attachSkillCatalog(bootContext);
  for (const id of contexts.ids()) {
    const project = contexts.peek(id);
    if (project) attachSkillCatalog(project);
  }
  contexts.onContextBuilt(attachSkillCatalog);
  watchProviderRuntimeAuth(providerRuntimeAuth, bootContext, contexts);
  attachProjectWebhooks(taskWebhooks, contexts);
  // #667: recovery ran inside the build, before any workspace stream attached to this project's
  // store, so the runs it resumed sent no `run` event. Until a cockpit refetches, its cross-project
  // index keeps the cold read's answer: every run the restart interrupted, shown as failed.
  contexts.onContextBuilt((ctx) => workspaceEvents.emit('project-ready', { project: ctx.id }));
  const projectRegistryEntry = workspaceProjects.registryEntry;
  workspaceProjects.bindContexts(bootContext, contexts);


  const app = new Hono();
  app.use('*', compression);
  // One cache per app: immutable bundle bytes and their negotiated encodings share a cap.
  // Live shell and worker files bypass it so a rebuild appears on the next request.
  // Compression runs outside route families and leaves live event streams untouched.
  const staticResponse = createStaticAssets();

  // Reject oversized request bodies before they reach any handler (#429). GETs
  // and SSE carry no body, so this only ever gates the mutating routes.
  app.use('*', bodyLimit({ maxSize: GLOBAL_BODY_LIMIT }));

  // Local APIs require a loopback Host, including health. Browser writes require
  // matching full authority or the verified local dev-proxy case. Health alone is
  // CORS-readable. Hosted mode delegates Host/auth policy to the deployment;
  // absent Origin remains valid for native clients. Keep WS trust checks separate.
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const isHostedMode = () => !resolveCapabilities(process.env, bindHost).localHandoff;
  app.use('/api/*', async (c, next) => {
    const hostName = hostnameOfHost(c.req.header('host'));
    // Strict twin of `isLoopbackHost`: a *missing* Host is untrusted here (an
    // absent header is not the "we defaulted to the loopback bind" case), and
    // the loopback match is anchored so `127.0.0.1.evil.com` does not pass.
    if (!isHostedMode() && !isLoopbackHostHeader(hostName)) {
      return c.json(
        {
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        },
        403,
      );
    }

    // /api/v1/health stays CORS-open for cross-origin discovery, but its Host is
    // still checked above: cross-origin is legitimate, DNS rebinding is not. The
    // path is spelled through V1_PREFIX rather than inline — an unversioned
    // literal here silently stopped matching when the API moved and left health
    // relying on the mutating-methods gate below to let its GETs through.
    if (c.req.path === `${V1_PREFIX}/health`) return next();

    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        const originHost = hostnameOfOrigin(origin);
        // Compare the whole authority, not just the hostname: a different PORT
        // is a different web origin, and on a dev machine `http://localhost:3000`
        // is every bit as foreign as `https://evil.tld`. Matching on hostname
        // alone would let any page served from another loopback port (a local
        // dev server rendering attacker content, an XSS in a local app) start a
        // shell-capable agent here.
        const sameOrigin = !!originHost && authorityOfOrigin(origin) === authorityOfHost(c.req.header('host'));
        // The one legitimate cross-port case is the `npm run dev` Vite proxy:
        // the browser fetches same-origin from `localhost:5173`, Vite's
        // `changeOrigin` rewrites Host to `127.0.0.1:<api port>` but forwards
        // the original Origin, so the authorities no longer line up. The browser
        // already told us what it thinks: `Sec-Fetch-Site: same-origin` is a
        // forbidden header name that page JS cannot set, and a cross-port
        // attacker page gets `same-site`, never `same-origin`. Requiring it
        // (plus loopback on both ends) readmits the proxy without readmitting
        // the attack. Browsers too old to send Sec-Fetch metadata simply fail
        // closed here — they still work against a non-proxied cockpit.
        const isDevProxy =
          c.req.header('sec-fetch-site') === 'same-origin' &&
          isLoopbackHostHeader(originHost) &&
          isLoopbackHostHeader(hostName);
        if (!sameOrigin && !isDevProxy) {
          return c.json(
            {
              error: 'forbidden: cross-origin request rejected (same-origin only)',
            },
            403,
          );
        }
      }
      // Belt-and-suspenders for browsers that send Sec-Fetch metadata: an
      // explicit cross-site marker is rejected regardless of the Origin dance.
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json(
          {
            error: 'forbidden: cross-site request rejected (same-origin only)',
          },
          403,
        );
      }
    }
    return next();
  });

  // Register project routes once; mount them under scoped and boot-alias prefixes.
  // Resolve default and boot ids to the boot context; context failures map through projectFailure.
  const resolveProjectScope = async (c: Context<ProjectApiEnv>, next: Next): Promise<Response | void> => {
    const raw = c.req.param('projectId');
    let project: ProjectContext;
    try {
      project = await workspaceProjects.resolveProject(raw);
    } catch (err) {
      const failure = workspaceProjects.projectFailure(err, raw ?? 'default');
      return c.json({ error: failure.error }, failure.status);
    }
    // The boot project's store could not open (#779): its runs are unknown, not absent, so its
    // routes answer with why rather than as an empty project. Only its routes: this resolver also
    // runs in front of every workspace route (`/health` above all), which must keep answering.
    if (project.store.unavailable && servesProjectRoute(c)) return c.json({ error: project.store.unavailable.message }, 409);
    c.set('project', project);
    return servesProjectRoute(c) ? withProjectAdmission(project.dataDir, next, (error) => c.json({ error: error.message }, 409)) : next();
  };
  /** Every method+path of the project table, under both prefixes; filled once `v1` is built. */
  let projectRoutePaths: ReadonlySet<string> = new Set();
  const servesProjectRoute = (c: Context): boolean =>
    matchedRoutes(c).some((route) => route.method !== 'ALL' && projectRoutePaths.has(`${route.method} ${route.path}`));

  // ---- static GUI ----------------------------------------------------------
  const webDir = resolveWebDir();
  const distDir = join(webDir, 'dist');
  const HTML_TYPE = 'text/html; charset=utf-8';
  const staticFile = (name: string, type: string) => async (c: Context): Promise<Response> => {
    // Read per request — the files are tiny and this keeps dev iteration live.
    //
    // Served out of the Vite build: the files are `public/` assets of the web package, which the
    // build copies verbatim into `web/dist`. One home, one URL — the same bytes these routes
    // hand out are what the bundle's `<img src>` and `<link rel="icon">` ask for by those exact
    // paths. Without a build there is nothing to serve, which is a 404 rather than a crash (the
    // shell route answers the same dev-only state with its build hint).
    const path = join(distDir, name);
    return staticResponse(c.req.raw, path, { 'content-type': type });
  };

  // Stable SharedWorker identity across same-origin tabs; its imported chunks stay hashed.
  app.get('/live-worker.js', async (c) => {
    const response = await staticFile('live-worker.js', 'text/javascript; charset=utf-8')(c);
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  });

  let hintLogged = false;
  const serveShell = async (c: Context): Promise<Response | undefined> => {
    const distIndex = join(distDir, 'index.html');
    // Async stat per request, like the reads below: `npm run build:web` in a
    // running cockpit takes effect on the next reload, no restart.
    const target = resolveGetRequest({
      path: c.req.path,
      distExists: await isFile(distIndex),
    });
    if (target === 'passthrough') return undefined;
    if (target === 'build-hint') {
      // Dev-only state (the tarball ships web/dist): serve the built-in hint
      // page instead of the app — the legacy fallback UI was deleted in R7.
      if (!hintLogged) {
        hintLogged = true;
        console.log(`Squawk: web/dist is missing — run \`npm run build:web\` to build the cockpit`);
      }
      return new Response(BUILD_HINT_HTML, {
        headers: { 'content-type': HTML_TYPE },
      });
    }
    return staticResponse(c.req.raw, distIndex, { 'content-type': HTML_TYPE });
  };

  // Hashed bundles/fonts of the built app. Vite fingerprints every name, so
  // the bytes behind a URL never change — cache them hard. Only plain
  // filenames are served: `basename('..')` is `'..'` (it resolves to the
  // assets dir itself and readFile would throw EISDIR), so dot-segments
  // and separator-bearing params get a 404, not a 500.
  app.get('/assets/:file', async (c) => {
    const file = c.req.param('file');
    if (!isSafeAssetFilename(file)) return c.json({ error: 'not found' }, 404);
    const path = join(distDir, 'assets', file);
    return staticResponse(c.req.raw, path, {
      'content-type': assetContentType(file),
      'cache-control': ASSET_CACHE_CONTROL,
    }, true);
  });

  registerBrandFileRoutes(app, staticFile);

  // ---- meta ----------------------------------------------------------------
  // CORS — deliberately for /api/health ONLY. Health exposes no secrets beyond
  // the repo path/remote; every other endpoint stays same-origin.
  const healthCors = async (c: Context, next: Next): Promise<Response | void> => {
    c.header('access-control-allow-origin', '*');
    if (c.req.method === 'OPTIONS') {
      // Preflight (e.g. Chrome Private Network Access) — allow the plain GET.
      c.header('access-control-allow-methods', 'GET');
      c.header('access-control-allow-private-network', 'true');
      return c.body(null, 204);
    }
    await next();
  };
  app.use(`${V1_PREFIX}/health`, healthCors);
  // One builder for both transports: `GET /api/health` (the authoritative,
  // CORS-open discovery endpoint) and the `health` topic on `/api/v1/ws` below
  // push the byte-identical shape, so the two can never drift.
  // Infer the health shape here: annotating it with HealthResponse makes the
  // contract circular, rather than deriving the DTO from what the handler sends.
  // Availability has its own lifetime: even a cold/max-stale health read must not
  // await agent startup. Repository/config freshness below remains independently bounded.
  // Detection starts one process per CLI, so it runs again only when the environment stamp
  // changes (hearsay-tools/squawk#3658). A settled change patches the cached snapshot alone:
  // re-reading Git here would only repeat work (hearsay-tools/squawk#3355).
  const backendChecks = createBackendChecks({
    detect: detectEnvironment,
    stamp: environmentStamp,
    onChange: (checks) => { void healthCache.patch((payload) => ({ ...payload, checks })).catch(() => {}); },
  });
  let bootRepoRoot: string | undefined;
  const trimHealthRepo = (repo: RepoInfo | null, localHandoff: boolean, fullRoot?: string): RepoInfo | null =>
    repo ? { ...repo, root: localHandoff ? (fullRoot ?? repo.root) : basename(repo.root) } : null;
  const healthSnapshot = async () => {
    const [checks, repo, config, workspace] = await Promise.all([
      backendChecks.read(),
      getRepoInfo(bootRoot),
      healthConfig(bootRoot, deps.home),
      workspaceSummary(),
    ]);
    bootRepoRoot = repo?.root;
    // Callers outside the cockpit read this JSON.
    const forge = resolveProjectForge(repo);
    const caps = capabilities();
    return {
      version,
      // Spread rather than `latestVersion: update?.latest`: an `undefined` VALUE is dropped by
      // JSON.stringify, so the key is absent on the wire — but writing it unconditionally types
      // the key as always-present, which is a shape no client ever receives. The contract schema
      // says `.optional()`, and contract-parity.test.ts holds the two together.
      ...(update?.latest !== undefined ? { latestVersion: update.latest } : {}),
      // Health is CORS-open and, in hosted mode, reachable off the loopback (#431). Local mode
      // keeps full paths; hosted/remote mode trims repoRoot and repo.root to basenames so host
      // checkout paths and usernames are never exposed.
      repoRoot: caps.localHandoff ? bootRoot : basename(bootRoot),
      repo: trimHealthRepo(repo, caps.localHandoff),
      checks,
      defaultRunner: config.defaultRunner as string,
      // Non-blocking: cached availability or null-until-warm — health must never pay a `gh`
      // shell-out. See detectGithubCached.
      forge: forge ? { kind: forge.kind, ...forge.detectCached() } : null,
      capabilities: caps,
      // Workspace enumeration (multi-project spec) — additive, id+name ONLY.
      // NEVER `projects[].root` here: health is the one CORS-open route, and
      // the repoRoot trim above exists precisely to keep absolute paths and
      // usernames away from cross-origin readers (#431) — per-project roots
      // would reintroduce that leak once per registered project. Absolute
      // roots live on the same-origin GET /api/projects instead. An
      // unreadable workspace degrades to `projects: []`.
      projects: workspace.projects,
      bootProject: workspace.bootProject,
      // Same CORS-open rule as repoRoot: a hosted cockpit sends no host path.
      plugins: pluginHealth(pluginLoadReport(), { hostPaths: caps.localHandoff }),
    };
  };
  // Stale-while-revalidate cache over the snapshot; see health-cache.ts.
  // Set while the topic has a subscriber (a noop when nobody is listening).
  let publishHealth: (data: unknown) => void = () => {};
  // Capabilities follow each read and push, like the gates (ADR 0055). Host paths follow them: a
  // snapshot cached in local mode must not send them once the cockpit is hosted.
  const inCurrentMode = (payload: Awaited<ReturnType<typeof healthSnapshot>>) => {
    const caps = capabilities();
    const repoRoot = caps.localHandoff ? bootRoot : basename(bootRoot);
    return { ...payload, capabilities: caps, repoRoot, repo: trimHealthRepo(payload.repo, caps.localHandoff, bootRepoRoot), plugins: pluginHealth(pluginLoadReport(), { hostPaths: caps.localHandoff }) };
  };
  const healthCache = createHealthCache({
    snapshot: healthSnapshot,
    publish: (cached) => {
      const payload = inCurrentMode(cached);
      publishHealth(payload);
      workspaceEvents.emit('health', payload);
    },
  });
  const refreshHealth = () => healthCache.refresh();

  // The read the GET and the topic snapshot share. On the live server (a hub is
  // injected) it answers from cache; without a hub — a bare app in tests — there is
  // no refresher keeping a cache coherent, so it computes fresh, exactly as before.
  const readHealth = async () => {
    if (!deps.socketHub) return healthSnapshot();
    return healthCache.read(inCurrentMode);
  };

  // ---- chained family: health (workspace-level) ----------------------------
  // Written as ONE chained expression rather than a loose `app.get(...)`
  // statement because Hono accumulates its route types through the chain: a
  // statement's return value is discarded, so `typeof app` would record nothing
  // and `hc<AppType>` would have no endpoint to offer. `createApp` mounts this
  // under both `/api` (the frozen legacy spelling) and `/api/v1`.
  const healthRoutes = new Hono().get('/health', async (c) => c.json(await readHealth()));

  // The push twin of the poll it replaced (#369): while at least one cockpit
  // holds the `health` topic the server re-reads the snapshot on the old 5 s
  // cadence and broadcasts ONLY when it changed — a `git checkout` in a
  // terminal reaches every open tab within a tick — and an idle workspace (no
  // subscriber) runs no timer. Nothing server-side watches `.git/HEAD`, so the
  // interval stays the honest mechanism; it just lives behind the socket now
  // instead of N tabs × 5 s HTTP polls. Every tick and every subscriber read
  // goes through the cache above, so N subscribers still cost one compute, and
  // a tick with no Git or CLI change reads file metadata and starts no process.
  deps.socketHub?.registerTopic(
    'health',
    {
      snapshot: readHealth,
      start: (publish) => {
        publishHealth = publish;
        const timer = setInterval(() => void refreshHealth(), HEALTH_TTL_MS);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          publishHealth = () => {};
        };
      },
    },
    // health IS the CORS-open discovery payload (#431), so it is the one topic
    // safe for any local page — including a cross-port page admitted by the
    // loopback fallback on a no-Sec-Fetch browser. Every other (future) topic
    // keeps the default: trusted connections only.
    { loopbackReadable: true },
  );
  // Pre-warm on the live-server path only (startServer injects the hub; a bare
  // app in tests does not, so tests never spawn the probes here): the cache
  // fills while the browser is still downloading the bundle, so its first
  // `GET /api/health` reads a warm value instead of the cold ~1 s compute.
  if (deps.socketHub) void refreshHealth();
  /**
   * Warm the whole of Squawk's agent knowledge — the three discovered defaults AND every extra
   * account — so no reader ever pays the first shell-out.
   *
   * Which login each agent is signed into is operating knowledge, not a settings-page detail: the
   * composer, the action gate, the accounts pane and every run resolution ask for it. So the server
   * learns it once, at boot, and keeps it (see the asymmetric cache lifetime in
   * `core/provider-auth.ts`); on-demand refresh rides on `?refresh=1` and on the explicit
   * invalidations — connect, repoint, remove, runtime rejection.
   *
   * Extra accounts are warmed ONE AT A TIME, after the defaults. Each is a CLI spawn, and a machine
   * with several accounts would otherwise fan out a spawn storm at exactly the moment the browser is
   * fetching the bundle; nothing is waiting on this, so sequential costs nothing that matters.
   *
   * Hosted mode warms only the defaults: the agent-profiles family is refused there, so there are
   * no accounts to learn about.
   */
  const warmAgentKnowledge = async (): Promise<void> => {
    await providerAuth.status().catch(() => {});
    if (!capabilities().localHandoff) return;
    const store = await loadAgentAccounts(deps.home).catch(() => defaultAgentAccountStore());
    for (const account of listAgentProfiles(store, registeredRunners().map(({ id }) => id))) {
      if (account.isDefault) continue; // covered by `status()` above
      await providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
    }
  };
  // Same gate as `refreshHealth`, same reason (startServer injects the hub; a bare app in tests does
  // not, so tests never spawn probes here). Fire-and-forget: a probe that fails leaves that row
  // cold, which is exactly the state every reader already handles.
  if (deps.socketHub) void warmAgentKnowledge();


  /**
   * Resolve `profileId` (absent = the discovered default) into a concrete account for `provider`.
   *
   * A dangling id is an ERROR here rather than the silent fall-back to the default that run
   * resolution performs. The difference is who is asking: a run is replaying a stored reference
   * and the default is the only safe answer it can act on, whereas a route is answering a user
   * who just named an account — telling them "unknown account" is honest, and quietly connecting
   * or reporting on a different one is not.
   */
  const resolveWorkspaceProfile = async (
    provider: ProviderId,
    profileId?: string,
  ): Promise<{ profile: ResolvedAgentProfile } | { error: string }> => {
    if (profileId === undefined || profileId === DEFAULT_AGENT_ACCOUNT_ID) {
      return { profile: defaultAgentProfile(provider) };
    }
    let accounts: readonly AgentAccount[];
    try {
      accounts = (await loadAgentAccounts(deps.home)).accounts;
    } catch {
      return { error: `unknown ${provider} account: ${profileId}` };
    }
    const stored = accounts.find((a) => a.id === profileId && a.provider === provider);
    if (!stored) return { error: `unknown ${provider} account: ${profileId}` };
    return { profile: resolveStoredProfile(stored) };
  };

  const openHandoffCheckout = (c: Context<ProjectApiEnv>, suffix = '') => {
    const checkout = runCheckout(c.get('project'), c.req.param('id')!, 'open');
    if ('status' in checkout) return checkout;
    // Hosted mode: there is no "my machine" to open a terminal on. The UI
    // hides the button when localHandoff is false — this is defense in depth.
    return !capabilities().localHandoff
      ? { status: 409 as const, body: { error: `local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)${suffix}` } }
      : checkout;
  };

  /**
   * The environment a terminal handoff must carry so the CLI lands on the right account.
   *
   * `profileId` is the one RECORDED on the step that owns the session, never the project's
   * current selection: `claude --resume <id>` reads `<configDir>/sessions`, so a handoff for a
   * run started on the work account and resumed after the project was switched back would find
   * nothing and silently open a fresh conversation.
   */
  const handoffEnv = async (
    provider: ProviderId,
    profileId: string | undefined,
  ): Promise<{ env: Record<string, string> } | { error: string }> => {
    const resolved = await resolveWorkspaceProfile(provider, profileId);
    if ('error' in resolved) {
      return { error: `this session belongs to an account that no longer exists (${profileId})` };
    }
    const { profile } = resolved;
    return { env: profile.isDefault ? {} : profileEnv(provider, profile.path) };
  };

  /** The copy-paste fallback shown when no terminal could be opened — same account, spelled for
   *  this platform's shell. `null` when the account environment cannot be embedded safely. */
  const handoffFallbackCommand = (cwd: string, command: string, env: Record<string, string>): string | null => {
    const prefixed = withEnvPrefix(command, env, process.platform);
    return prefixed === null ? null : `cd ${shellQuote(cwd)} && ${prefixed}`;
  };

  /** A registered project's realpath'd root, or null when the id is unknown. */
  const projectRootFor = async (projectId: string): Promise<string | null> => {
    try {
      return (await loadWorkspaceConfig(deps.home.workspaceConfig)).projects.find((p) => p.id === projectId)?.root ?? null;
    } catch {
      return null;
    }
  };

  const providersRoutes = createProvidersRoutes({
    bootRoot,
    capabilities,
    modelCatalog,
    providerAuth,
    providerStatus,
    invalidateHostModels,
    workspaceConfig,
    workspaceEvents,
    openTerminal,
    resolveWorkspaceProfile,
  });

  const agentProfilesRoutes = createAgentProfilesRoutes({
    home: deps.home,
    capabilities,
    providerAuth,
    providerStatus,
    invalidateHostModels,
    workspaceProjects,
    resolveWorkspaceProfile,
    projectRootFor,
  });

  const workspaceBrowseRoot = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig(deps.home.workspaceConfig)).browseRoot;
    } catch {
      return defaultWorkspaceConfig().browseRoot;
    }
  };

  const projectsRoutes = createProjectsRoutes({
    home: deps.home,
    capabilities,
    contexts,
    workspaceProjects,
    workspaceEvents,
    checkoutProgress,
    semaphore: deps.semaphore,
    taskWebhookFetch: deps.taskWebhookFetch,
    cloneRunner: deps.cloneRunner,
    projectCommandRunner: deps.projectCommandRunner,
    workspaceBrowseRoot,
  });

  // ---- GUI clone (multi-project spec, step 4.3) ----------------------------
  // "Add project → Clone from GitHub": clone into the checkout root, then
  // register the result through `registerFolder` above (same guards, same
  // `project-added`). Everything dangerous — where the clone may land, and
  // what a failed clone is allowed to delete — lives in src/server/checkout.ts.
  //
  // Long-running by design (the spec's contract): the response lands when the
  // clone finishes, and the dialog's liveness comes from `checkout-progress`
  // events on the workspace stream. `checkoutId` is the cockpit's own
  // correlation token, echoed on every event so two tabs cloning at once never
  // render each other's progress.

  const workspaceConfigRoutes = createWorkspaceConfigRoutes({
    home: deps.home,
    semaphore: deps.semaphore,
    archiveOnMergeChanged: deps.archiveOnMergeChanged,
  });

  const fsBrowseRoutes = createFsBrowseRoutes(workspaceBrowseRoot);
  const skillsRoutes = createSkillsRoutes({ home: deps.home, capabilities, skillCatalog, resolveWorkspaceProfile });
  const uiStateRoutes = createUiStateRoutes();
  const workflowsRoutes = createWorkflowsRoutes();
  const planRoutes = createPlanRoutes({ home: deps.home, skillCatalog, providerActionError, resolveWorkspaceProfile });

  const { automationsRoutes, automationChecksRoutes } = createAutomationsRouteBundles({
    home: deps.home,
    capabilities,
    modelCatalog,
    providerStatus,
    bootContext,
    contexts,
    workspaceEvents,
    automationsChanged,
    resolveProjectForge,
  });

  // ---- runs ----------------------------------------------------------------

  // Additive `usage` field (#348): the latest CPU/RSS/proc-count sample of the
  // run's live process tree — absent for finished runs and when `ps` yields
  // nothing. The stored record itself is never touched.
  const withUsage = (run: RunRecord, finishBlocked?: string | null): ApiRun => {
    const usage = currentUsage(run.id);
    const { sessionId, backend } = latestSession(run);
    const command = sessionId ? resumeCommand(resolveRunnerId(backend), sessionId) : null;
    return { ...run, ...(usage ? { usage } : {}), ...(command ? { cliResumeCommand: command } : {}),
      ...(runnerDefinition(resolveRunnerId(backend)).cli.interactive === false ? { cliHandoff: false as const } : {}),
      ...(finishBlocked !== undefined ? { finishBlocked } : {}) };
  };

  // A list row (#817) with the same live `usage` sample `withUsage` attaches. The sampler is
  // process-wide, so a workspace-level answer can carry it for every project's runs at once — a
  // cold project's stored summaries included. Appended last, exactly where `toRunSummary` puts it.
  const withLiveUsage = (summary: RunSummary): RunSummary => {
    const usage = currentUsage(summary.id);
    return usage ? { ...summary, usage } : summary;
  };

  // One run feed for every workspace stream connection (hearsay-tools/cezarion#2730): one store
  // subscription per project, one process-wide `seq`, each frame built once per mode.
  const workspaceRunFeed = createWorkspaceRunFeed({
    bootStore: bootContext.store, contexts, onWorkspaceEvent: (listener) => workspaceEvents.on(listener),
    onUsage, allUsage, withLiveUsage,
  });

  /**
   * Gate every run control by family ownership: refuse foreign or quarantined writers with 409;
   * adopt proven dead owners without resuming agents. Reads remain available. Stop carries its
   * cancellation through adoption. `adoptFallbackControl` runs first for a `.ai/squawk/` family.
   */
  const requireRunControl = async (c: Context<ProjectApiEnv>, next: Next) => {
    const id = c.req.param('id');
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || id === undefined) return next();
    const { store, manager } = c.get('project');
    if (store.claims.runOwnership(id) === 'orphaned') {
      const stop = c.req.method === 'POST' && c.req.path.endsWith('/cancel');
      if (await manager.adoptOrphanedRun(id, { stop }) && stop && store.getRun(id)?.status === 'cancelled') c.set('stoppedOnAdoption', true);
    }
    const refusal = store.claims.writeRefusal(id);
    if (!refusal) return next();
    // The delegation route in this family answers in the delegation error shape it always uses.
    return c.req.path.endsWith('/worker-destroy')
      ? c.json({ code: 'incompatible_state' as const, error: refusal }, 409)
      : c.json({ error: refusal }, 409);
  };

  // ---- chained family: runs lifecycle + artifacts (project-scoped) ----
  const delegationService = deps.delegation?.service ?? new DelegationService(deps.workerCleanup);
  delegationService.setDiscovery({ models: modelCatalog, providers: providerStatus });
  const runsRoutes = new Hono<ProjectApiEnv>()
    .use('/runs/:id', adoptFallbackControl, requireRunControl)
    .use('/runs/:id/*', adoptFallbackControl, requireRunControl)
    // Legacy (older clients): every full record. The cockpit and `cez task` read `/run-summaries`.
    .get('/runs', (c) => c.json(c.get('project').store.queries.listAllRunsForLegacyRoute().map(run => withUsage(run))))
    // The slim list (#817): the same runs in the same order as `GET /runs`, from the stored
    // `toRunSummary` column with memory laid over it (#779), so the list decodes no record.
    // `?archived=recent` (#864) is the window the cockpit reads: every unarchived run plus the newest
    // `ARCHIVED_WINDOW` archived roots. The default stays every run, for clients that list them all.
    .get('/run-summaries', queryZodValidator(runSummariesQuerySchema), (c) => {
      const archivedWindow = c.req.valid('query').archived === 'recent' ? ARCHIVED_WINDOW : undefined;
      return c.json(c.get('project').store.queries.listRunSummaries({ archivedWindow }).runs.map(withLiveUsage));
    })
    // The archived roots past that window, a page at a time, newest first (#864).
    .get('/run-summaries/archived', queryZodValidator(archivedRunsQuerySchema), (c) => {
      const { before, limit, q } = c.req.valid('query');
      const project = c.get('project');
      // The page shows each task's origin line, so `q` matches what it names: the automation's
      // name, or its recorded id while automations are off, as the cockpit's filter does (#1616).
      const automationNames = new Map(capabilities().automations
        ? project.automationStore.list().map((automation) => [automation.id, automation.name] as const) : []);
      const page = project.store.queries.listArchivedRuns({
        limit: limit ?? ARCHIVED_RUNS_PAGE_DEFAULT,
        automationNames,
        ...(before !== undefined ? { before } : {}),
        ...(q !== undefined ? { q } : {}),
      });
      if ('error' in page) return c.json({ error: page.error }, 400);
      const body: ArchivedRunsResponse = { ...page, runs: page.runs.map(withLiveUsage) };
      return c.json(body);
    })
    .get('/runs/:id/relationships', paramZodValidator(runIdParamSchema), queryZodValidator(workerEmptyRequestSchema), (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.valid('param').id);
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.json(runRelationshipsSchema.parse(runRelationships(store, run)));
    })
    .post('/runs/:id/worker-destroy', queryZodValidator(workerEmptyRequestSchema, { code: 'invalid_input', message: 'Invalid cleanup query' }), paramZodValidator(runIdParamSchema, { code: 'invalid_input', message: 'Invalid worker ID' }), jsonZodValidator(workerDestroyRequestSchema, { absent: {}, malformed: null, code: 'invalid_input', message: 'Invalid cleanup input' }), async c => {
      const project = c.get('project');
      delegationService.registerProject(project);
      try {
        const result = await delegationService.destroyForHuman(project.id, c.req.valid('param').id, c.req.valid('json'));
        return result.state === 'incomplete' ? c.json(result, 409) : c.json(result, 200);
      } catch (error) { const failure = delegationFailure(error); return c.json(failure.body, failure.status); }
    })
    // Registered before the `/:id/...` routes so "archive-finished" and "read-all"
    // never match as a run id.
    .post('/runs/archive-finished', jsonZodValidator(archiveFinishedRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json(c.get('project').store.archive.archiveFinished(c.req.valid('json').scope, c.req.valid('json').automation)))
    // The read-receipt sweep (#unread-done-items) — the mark-read twin of the archive
    // sweep above, and under the same registration-order guard.
    .post('/runs/read-all', jsonZodValidator(markAllReadRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json({ read: c.get('project').store.readFlags.markAllRead(c.req.valid('json').automation) }))
    .post('/runs/:id/archive', jsonZodValidator(archiveSchema, { absent: ({}) }), async (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      // An empty/absent body archives (the common case); a malformed body degrades
      // to `{}` just as before, but a wrong-typed `archived` is now a 400 (#429).
      // Archiving also retires any pending usage-limit resume, but that rule belongs to
      // `setArchived` itself — the bulk sweep must obey it too (spec
      // 2026-08-03-auto-resume-after-usage-limit).
      const parsed = { data: c.req.valid('json') };
      const run = store.archive.setArchived(id, parsed.data.archived !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
    // Pin one task to the top of this project's list, or unpin it (#935). The archive route's
    // twin in every respect: an absent body pins (the common case), the answer is the updated
    // record, and the change rides the existing `run` SSE because `setPinned` touches. No new
    // event and no new response shape.
    .post('/runs/:id/pin', paramZodValidator(runIdParamSchema), jsonZodValidator(pinRunInputSchema, { absent: {}, malformed: null }), (c) => {
      const { store } = c.get('project');
      const run = store.readFlags.setPinned(c.req.valid('param').id, c.req.valid('json').pinned !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
    // Task webhook opt-in for one run (#589), valid in every state — handing a finished task to a
    // bot for follow-up is a real case. Turning it on sends one `task.subscribed` delivery with
    // the note; the note never reaches the agent session. Either direction leaves a durable
    // `handoff` event so the thread shows when and why. Idempotent: repeating `true` with a
    // new note is how "Send a note…" works.
    .post('/runs/:id/notify', paramZodValidator(runIdParamSchema), jsonZodValidator(notifyRunInputSchema), async (c) => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const { notify, message } = c.req.valid('json');
      if (!project.store.getRun(id)) return c.json({ error: 'not found' }, 404);
      if (notify) {
        const entry = await projectRegistryEntry(project.id).catch(() => undefined);
        if (taskWebhookList(entry).length === 0) return c.json({ error: NO_WEBHOOK_ERROR }, 400);
      }
      const run = project.store.updateRun(id, { notify: notify ? true : undefined });
      if (!run) return c.json({ error: 'not found' }, 404);
      project.store.eventLog.appendEvent(id, {
        type: 'handoff',
        notify,
        ...(message === undefined ? {} : { message }),
      });
      if (notify) taskWebhooks.attach(project).subscribed(id, message);
      return c.json(run);
    })
    // The per-task off switch for that resume (the workspace setting is Settings → Resources).
    // Idempotent: a run with nothing pending answers 200 too, because "this task will not
    // resume itself" is equally true either way.
    .delete('/runs/:id/auto-resume', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      manager.cancelAutoResume(id);
      return c.json({ cancelled: true as const });
    })
    .post('/runs/:id/read', (c) => {
      // No body: opening a thread marks it read, full stop. Stamps `seenAt = now` and
      // returns the updated record (which also rides the `run` SSE via `touch`).
      const run = c.get('project').store.readFlags.setRead(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
    .post('/runs/:id/unread', (c) => {
      // The mark-unread twin (#775) — bodyless like its read counterpart: clearing the
      // receipt is the whole action, so there is nothing to say about it. Sits under
      // `/runs/:id/`, so the `read-all` registration-order caveat above does not apply.
      const run = c.get('project').store.readFlags.setUnread(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs', jsonZodValidator(createRunInputSchema, { runners: { ids: ['runner', 'steps.*.runner'] } }), async (c) => {
      const { id: projectId, root: repoRoot, manager, store } = c.get('project');
      const body = c.req.valid('json');
      const clientRequest = clientRequestOf(body);
      if (clientRequest) {
        const replay = replayedRun(store.queries, clientRequest);
        if (replay && 'error' in replay) return c.json({ error: replay.error }, replay.status);
        if (replay) return c.json(replay.run, 200 as const);
      }
      const locked = modelLockRefusal(repoRoot, body, deps.home);
      if (locked) return c.json({ error: locked.error }, locked.status);
      const resolved = await resolveStartWorkflow(repoRoot, body);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const { workflow } = resolved;
      const runner = body.runner === undefined ? (await loadConfig(repoRoot, deps.home)).defaultRunner : registeredRunnerId(body.runner);
      const blocked = await providerGateRefusal(providerActionError, workflow, runner, { repoRoot, picks: { [runner]: body.agentProfile } });
      if (blocked) return c.json({ error: blocked.error }, blocked.status);
      const badProfile = await agentProfileRefusal(resolveWorkspaceProfile, runner, body.agentProfile);
      if (badProfile) return c.json({ error: badProfile.error }, badProfile.status);
      const noWebhook = await notifyRefusal(body.notify, projectId, projectRegistryEntry);
      if (noWebhook) return c.json({ error: noWebhook.error }, noWebhook.status);
      const started = launchRun(manager, workflow, startRunInput(body), clientRequest);
      if ('error' in started) return c.json({ error: started.error }, started.status);
      return c.json(started.run, started.status);
    })

    .get('/runs/:id', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (run) return c.json(withUsage(run, manager.finishBlockedReason(run.id) ?? null));
      // A row in runs.db this version cannot decode (#779): listed until read, so say why it will not open.
      return c.json({ error: store.isUnreadable(id) ? UNREADABLE_RUN_ERROR : 'not found' }, 404);
    })

    .get(
      '/runs/:id/history',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runHistoryQuerySchema),
      async (c) => {
        const { store } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        try {
          return c.json(
            await readRunHistoryPage(store.claims.sourceDataDir(id), id, c.req.valid('query').cursor),
          );
        } catch (error) {
          if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      },
    )

    .get(
      '/runs/:id/history-context',
      paramZodValidator(runIdParamSchema),
      async (c) => {
        const { store } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        return c.json(await deriveRunContextEvents(store.claims.sourceDataDir(id), id));
      },
    )

    // Editable titles (#389). The UI displays `titleSummary ?? title`, so a
    // user edit sets BOTH: `title` (the record's own name — the raw task stops
    // being it the moment the user renames the run) and `titleSummary` (what
    // actually displays). The auto-summarizer only ever fills an *unset*
    // titleSummary (TurnBookkeeper.recordTurnEnd), so an edit wins over any past or
    // future auto-summary. Answers the updated record.
    .patch('/runs/:id', jsonZodValidator(patchRunSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // The prompt is editable only while the run is still queued (#472). Checked
      // BEFORE the title write so a rejected PATCH is a no-op rather than a partial
      // one. `title` itself keeps working on any status — no regression to #389.
      if (parsed.data.task !== undefined) {
        const foldedChars = foldedLength(parsed.data.task, store.getRun(id)?.queuedMessages ?? []);
        if (foldedChars > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${foldedChars})`,
            },
            400,
          );
        }
        if (!manager.editTask(id, parsed.data.task)) {
          return c.json({ error: 'run already started' }, 409);
        }
      }
      if (parsed.data.title !== undefined) {
        // titleOrigin 'user' permanently stops the namer's live updates for this run
        // (spec 2026-07-17-task-auto-naming).
        store.updateRun(id, {
          title: parsed.data.title,
          titleSummary: parsed.data.title,
          titleOrigin: 'user',
        });
      }
      // Completion controls and task access (hearsay-tools/cezarion#2784) change at any status.
      const { title: _title, task: _task, ...options } = parsed.data;
      if (Object.values(options).some(value => value !== undefined)) store.updateRun(id, options);
      return c.json(store.getRun(id));
    })

    .post('/runs/:id/cancel', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      // Still asked of the manager after an adoption stopped the run: a worker's stop bookkeeping is its.
      const cancelled = manager.cancel(id) || c.get('stoppedOnAdoption') === true;
      return c.json({ cancelled });
    })

    // Live-session participation (spec 002): deliver a user message (text +
    // pasted screenshots) into the run's open claude session.
    .post('/runs/:id/permissions', paramZodValidator(permissionRunIdParamSchema), jsonZodValidator(permissionDecisionSchema), (c) => {
      const { store, manager } = c.get('project');
      const { id } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const { requestId, optionId } = c.req.valid('json');
      if (!manager.respondPermission(id, requestId, optionId)) {
        return c.json({ error: 'permission request is no longer available or option is invalid' }, 409);
      }
      return c.json({ delivered: true as const });
    })

    .post('/runs/:id/messages', jsonZodValidator(messageSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // Stacking onto a queued prompt mutates an existing task and invokes no provider.
      // Provider availability still gates live delivery after the record leaves `queued`, but
      // must not strand prompt authoring just because an unrelated fallback provider is
      // disconnected (provider-auth spec: disabling never blocks existing-task mutations).
      // In the dequeue race, the ladder below safely turns this into a starting-state buffer.
      if (run.status !== 'queued') {
        const blocked = await providerActionError([resolveRunnerId(providerForActiveRun(run))], { repoRoot: c.get('project').root, run, live: true });
        if (blocked) return c.json({ error: blocked }, 409);
      }
      const content: PastedContent[] = [
        ...parsed.data.images.map(toPastedContent),
        ...(parsed.data.text.trim() ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock] : []),
      ];
      // Three-rung delivery ladder (#472). Branch on the ENGINE's answer rather
      // than a status read here: the handler cannot observe the dequeue safely
      // (the record is written a tick later), the engine can.
      //   live session → delivered · still queued → folded into the prompt
      //   starting up  → buffered  · anything else → 409, exactly as before
      if (manager.sendMessage(id, content)) return c.json({ delivered: true });

      const currentRun = store.getRun(id);
      const stack = currentRun?.queuedMessages ?? [];
      // Bounds apply only to a message that is actually about to be stacked. Without this
      // gate an over-long message posted to a *finished* run would answer `400 prompt too
      // long` when the truthful answer is `409 session closed`. The status read is safe
      // here because it only decides whether to reject EARLY — `enqueueMessage` still
      // re-checks against the engine's own queue before writing anything.
      if (currentRun?.status === 'queued') {
        if (stack.length >= MAX_QUEUED_MESSAGES) {
          return c.json({ error: `too many queued messages — ${MAX_QUEUED_MESSAGES} message limit` }, 400);
        }
        const stackedImages = stack.reduce((n, m) => n + (m.images?.length ?? 0), 0);
        if (stackedImages + parsed.data.images.length > MAX_QUEUED_ATTACHMENTS) {
          return c.json({ error: `too many queued attachments — ${MAX_QUEUED_ATTACHMENTS} attachment limit across the stack` }, 400);
        }
        const prospective = foldedLength(currentRun.task, [...stack, { text: parsed.data.text }]);
        if (prospective > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
            },
            400,
          );
        }
      }

      const queued = manager.enqueueMessage(id, content);
      if (queued) return c.json({ queued: true, message: queued });
      if (manager.deferMessage(id, content)) return c.json({ deferred: true });
      return c.json({ error: 'session closed' }, 409);
    })

    // Edit / remove a stacked message (#472). Registered before any conflicting
    // `/:id` route so `queued-messages` never matches as a run id.
    .patch('/runs/:id/queued-messages/:msgId', jsonZodValidator(queuedMessagePatchSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const msgId = c.req.param('msgId');
      const stack = run.queuedMessages ?? [];
      const existing = stack.find((m) => m.id === msgId);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const effectiveText = parsed.data.text ?? existing.text;
      const effectiveImageCount = parsed.data.images?.length ?? existing.images?.length ?? 0;
      if (!effectiveText.trim() && effectiveImageCount === 0) {
        return c.json({ error: 'message needs text or at least one attachment' }, 400);
      }

      const others = stack.filter((m) => m.id !== msgId);
      const stackedImages = others.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (stackedImages + effectiveImageCount > MAX_QUEUED_ATTACHMENTS) {
        return c.json({ error: `too many queued attachments — ${MAX_QUEUED_ATTACHMENTS} attachment limit across the stack` }, 400);
      }
      const prospective = foldedLength(run.task, [...others, { text: effectiveText }]);
      if (prospective > MAX_FOLDED_TASK_CHARS) {
        return c.json(
          {
            error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
          },
          400,
        );
      }

      const images: PastedContent[] | undefined = parsed.data.images?.map(toPastedContent);
      const message = manager.editQueuedMessage(id, msgId, {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(images !== undefined ? { images } : {}),
      });
      if (!message) return c.json({ error: 'run already started' }, 409);
      return c.json({ message });
    })

    .delete('/runs/:id/queued-messages/:msgId', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const msgId = c.req.param('msgId');
      if (!(run.queuedMessages ?? []).some((m) => m.id === msgId)) {
        return c.json({ error: 'not found' }, 404);
      }
      if (!manager.removeQueuedMessage(id, msgId)) return c.json({ error: 'run already started' }, 409);
      return c.json({ removed: true });
    })

    // "Finish": gracefully close a waiting session — the run completes as done.
    .post('/runs/:id/finish', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const finished = manager.finish(id);
      if (!finished) return c.json({ error: manager.finishBlockedReason(id) ?? 'no open session' }, 409);
      return c.json({ finished: true });
    })

    // "Continue" (spec 003): reopen a finished run's session in-process.
    .post('/runs/:id/continue', jsonZodValidator(continueSchema, { absent: ({}), runners: { ids: ['runner'] } }), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Bounded resume text (#429); an empty/absent body still just re-runs on the
      // run's current backend, and a runner/model override reopens on that engine (#401).
      const parsed = { data: c.req.valid('json') };
      if (
        agentModelsLocked(repoRoot, process.env, deps.home) &&
        (parsed.data.model?.trim() || parsed.data.effort?.trim())
      ) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      // Untouched tasks execute their original workflow, including step-level runners.
      // Resolve the same fallback as POST /runs, and pass it through so validation
      // and execution use the same provider even when the record inherited config.
      // Before the provider check: a run saved on a removed runner has no provider of its own.
      if (run.removedRunner !== undefined && parsed.data.runner === undefined) {
        return c.json({ error: removedRunnerMessage(run.removedRunner) }, 409);
      }
      const untouched = isUntouchedCancelledRun(run);
      const { original: originalProvider, target: provider, required } = await continueRunProviders(
        run, parsed.data.runner, untouched, async () => (await loadConfig(repoRoot, deps.home)).defaultRunner,
      );
      const blocked = await providerActionError(required, { repoRoot, run, untouched, runners: { original: originalProvider, target: provider } });
      if (blocked) return c.json({ error: blocked }, 409);
      const result = manager.continueRun(id, {
        text: parsed.data.text,
        images: parsed.data.images?.map(toPastedContent),
        runner: untouched || parsed.data.runner !== undefined ? provider : undefined,
        ...(untouched ? { originalRunner: originalProvider } : {}),
        model: parsed.data.model,
        effort: parsed.data.effort,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ continued: true });
    })

    // "Open in terminal" (spec 003): hand the session off to a real terminal —
    // in the task's worktree when it still exists (spec 006).
    .post('/runs/:id/open-in-cli', async (c) => {
      const project = c.get('project');
      const checkout = openHandoffCheckout(c, '; resume the session from a machine that has the checkout');
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      if (checkout.run.removedRunner !== undefined) return c.json({ error: removedRunnerMessage(checkout.run.removedRunner) }, 409);
      const { sessionId, backend: savedBackend, profileId } = latestSession(checkout.run), backend = resolveRunnerId(savedBackend);
      if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
      if (runnerDefinition(backend).cli.interactive === false) return c.json({ error: 'this runner has no interactive CLI' }, 409);
      const resume = checkout.resumeAllowed ? resumeCommand(backend, sessionId) : undefined;
      // Fails closed on an id we do not recognise — see resumeCommand (open-mercato/cezar#431).
      if (resume === null) return c.json({ error: 'the recorded session id has an unexpected shape' }, 409);
      const blocked = await providerActionError([backend], { repoRoot: project.root, picks: { [backend]: resume ? profileId ?? DEFAULT_AGENT_ACCOUNT_ID : undefined } });
      if (blocked) return c.json({ error: blocked }, 409);
      const cwd = checkout.directory();
      const refusal = fallbackProjectWriteError(cwd);
      if (refusal) return c.json({ error: refusal }, 409);
      const account = resume
        ? { command: resume, ...await handoffEnv(backend, profileId) }
        : await freshCliHandoff(backend, project.root, deps.home);
      if ('error' in account) return c.json({ error: account.error }, 409);
      const { command } = account;
      const fallback = handoffFallbackCommand(cwd, command, account.env);
      // Fail closed for the same reason as the session id: a terminal opened without the
      // account's config dir resumes nothing and says nothing about why.
      if (fallback === null) {
        return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
      }
      const opened = await openTerminal(cwd, command, account.env);
      if (!opened) {
        return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
      }
      return c.json({ opened: true, command });
    })

    // Open a run's worktree (or the repo root) in the chosen local app.
    .post('/runs/:id/open-in', jsonZodValidator(openInSchema), async (c) => {
      const project = c.get('project');
      const checkout = openHandoffCheckout(c);
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      // Follows the safeParse convention (#429); the downstream allowlist match is the real
      // injection guard, this just validates the shape.
      const { target, path: relPath } = c.req.valid('json');
      const dir = checkout.directory();

      if (target === 'default') {
        const worktree = checkout.defaultWorktree();
        if (typeof worktree !== 'string') return c.json(worktree.body, worktree.status);
        return openRunDefaultApp(c, worktree, relPath, openFile);
      }
      const cliRunner = agentCliRunner(target);
      if (cliRunner) {
        return openRunCli(c, checkout.run, cliRunner, dir, project.root, { home: deps.home,
          providerActionError, resumeCommand, handoffEnv, handoffFallbackCommand, openTerminal,
        }, checkout);
      }
      return openRunApp(c, target, dir, openApp);
    })

    // Handoff journal plus stored records (hearsay-tools/cezarion#1809): unknown task is 404; no file is ''.
    .get('/runs/:id/handoff', (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.text(renderHandoffRecords(readHandoff(store.claims.sourceDataDir(run.id), run.id), run.handoffRecords), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    })

    .get('/runs/:id/images/:file', paramZodValidator(attachmentFileParamSchema), async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const file = c.req.valid('param').file;
      const path = await resolveAttachmentPathAsync(store.claims.sourceDataDir(run.id), run.id, file);
      if (!path) return c.json({ error: 'not found' }, 404);
      const ext = file.split('.').pop() ?? '';
      const image = IMAGE_TYPES[ext];
      // An image answers exactly as it always has — the cockpit renders it in an `<img>`.
      // Everything else is a user-supplied file (#950) and leaves under the download headers.
      const type = image ?? FILE_TYPES[ext] ?? 'application/octet-stream';
      return new Response(await readFile(path), {
        headers: {
          'content-type': type,
          'cache-control': 'private, max-age=31536000, immutable',
          ...(image
            ? {}
            : {
                'x-content-type-options': 'nosniff',
                // Engine-generated names are `pasted-3.pdf`-shaped, but a header value is not the
                // place to find out otherwise: anything exotic degrades to an underscore rather
                // than to a quote that could split the header.
                'content-disposition': `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
              }),
        },
      });
    })

    // Task diff (spec 006): what this run changed — its worktree vs its base.
    .get('/runs/:id/diff', async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'existing-worktree' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      if (!checkout.directory) return c.text('(no worktree — this task ran directly in the repo working tree)');
      const result = await worktreeDiff(checkout.directory, checkout.run.baseBranch ?? 'HEAD', undefined, checkout.beforeLiveIndex);
      if (typeof result !== 'string') return c.json({ error: result.error }, 409);
      return c.text(result);
    })

    .get('/runs/:id/changes', async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'working-directory' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { run, directory: workingDirectory } = checkout;
      const result = await collectChanges(workingDirectory, run.baseBranch ?? 'HEAD', {
        beforeLiveIndex: checkout.beforeLiveIndex,
        taskBranch: run.branch,
        // Anchors a repointed worktree at the branch as this run found it (#751).
        runStartedAt: run.startedAt,
        // A read-only GET against the user's real checkout must never modify its index.
        intentToAdd: run.worktreePath ? undefined : false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    // The run's own commits (<base>..HEAD on the worktree branch) — the Commits tab.
    .get('/runs/:id/commits', async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'working-directory' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { run, directory: workingDirectory } = checkout;
      const result = await collectRunCommits(workingDirectory, run.baseBranch ?? 'HEAD');
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ commits: result.commits });
    })

    // One of the run's commits, structured like the Changes tab (reuses collectCommitChanges).
    .get('/runs/:id/commit/:sha', async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'working-directory' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { directory: workingDirectory } = checkout;
      const result = await collectCommitChanges(workingDirectory, c.req.param('sha'));
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.commit);
    })

    .get('/runs/:id/file-link', paramZodValidator(artifactParamsSchema.omit({ artifactId: true })), queryZodValidator(fileLinkQuerySchema), async (c) => {
      const { root, store } = c.get('project');
      const checkout = runCheckout(c.get('project'), c.req.valid('param').id, 'read', { directory: 'recorded-path-or-root' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { run, directory: workingDirectory } = checkout;
      const query = c.req.valid('query');
      const loaded = await loadFileLink({ dataDir: store.claims.sourceDataDir(run.id), runId: run.id, projectRoot: root, workingDirectory, path: query.path });
      if (query.raw === '1') {
        if (!loaded.imageBytes || loaded.preview.type !== 'file') return c.json({ error: 'Only bounded raster images can be served inline.' }, 409);
        return c.body(new Uint8Array(loaded.imageBytes).buffer, 200, {
          'content-type': rasterMime(loaded.preview.path)!, 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
        });
      }
      return c.json(loaded.preview);
    })
    .get('/runs/:id/artifacts', paramZodValidator(artifactParamsSchema.omit({ artifactId: true })), async (c) => {
      const { store } = c.get('project');
      const id = c.req.valid('param').id;
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      return c.json({ artifacts: await listArtifacts(runArtifactDirectory(store, id), id) });
    })
    .get('/runs/:id/artifacts/:artifactId', paramZodValidator(artifactParamsSchema), async (c) => {
      const { store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(runArtifactDirectory(store, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      return c.json(artifactPreview(entry.metadata, entry.bytes));
    })
    .get('/runs/:id/artifacts/:artifactId/metadata', paramZodValidator(artifactParamsSchema), async (c) => {
      const { store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const artifact = await readArtifactMetadata(runArtifactDirectory(store, id), id, artifactId);
      if (!artifact) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      return c.json({ artifact });
    })
    .get('/runs/:id/artifacts/:artifactId/download', paramZodValidator(artifactParamsSchema), async (c) => {
      const { store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(runArtifactDirectory(store, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      return c.body(new Uint8Array(entry.bytes).buffer, 200, {
        'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${entry.metadata.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
      });
    })
    .get('/runs/:id/artifacts/:artifactId/image', paramZodValidator(artifactParamsSchema), async (c) => {
      const { store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(runArtifactDirectory(store, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      const mime = rasterMime(entry.metadata.name);
      if (!mime) return c.json({ error: 'Only raster images can be served inline.' }, 409);
      return c.body(new Uint8Array(entry.bytes).buffer, 200, {
        'content-type': mime, 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
      });
    })

    // Files tab: directory listing (path omitted or a dir) or file content
    // (size-capped, binary flagged). Traversal-safe — readWorktreePath rejects
    // anything escaping the worktree. `raw=1` (R5 Step 1.6) serves the BYTES of
    // image files only, for the preview's inline <img> — never HTML/JS/etc., so
    // no worktree file can become a same-origin document, and never past the
    // size cap. The no-script CSP neutralizes SVG opened as a top-level URL.
    //
    // An `Accept` that asks for images reaches the same raw branch without the flag — which is
    // what an `<img>` sends — while the flag still wins whenever it is present and `*<slash>*`
    // (every `fetch`) still gets the JSON listing. See `negotiate`.
    .get('/runs/:id/files', queryZodValidator(worktreeFilesQuerySchema), async (c) => {
      const query = c.req.valid('query');
      c.header('vary', 'Accept');
      const wantsRaw =
        query.raw !== undefined
          ? query.raw === '1'
          : negotiate(c.req.header('accept'), FILE_FORMATS) === 'image/*';
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'working-directory' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { directory: workingDirectory } = checkout;
      const result = await readWorktreePath(workingDirectory, query.path ?? '');
      if (result.kind === 'invalid' || result.kind === 'missing') {
        return c.json({ error: result.error }, 409);
      }
      if (result.kind === 'dir') {
        return c.json({
          // `as const` or the literal widens to `string` during Hono's route-type inference,
          // which erases the discriminant a consumer narrows on — `entry.type === 'dir'` then
          // leaves `never` and every field access on it fails. The wire was always 'dir'.
          type: 'dir' as const,
          path: result.path,
          entries: result.entries,
        });
      }
      if (wantsRaw) {
        const mime = imageMimeType(result.path);
        if (mime === null || result.tooLarge) {
          // `?raw=1` ASKED for bytes, so it hears why it cannot have them (a 409 with the
          // reason). An `Accept` is only a preference, so a
          // resource with no image representation falls THROUGH to the JSON answer below rather
          // than turning a browser's navigation to a text file into an error.
          if (query.raw !== undefined) {
            const error =
              mime === null
                ? `raw serving is limited to images: ${result.path}`
                : `file too large to serve raw (${result.size} bytes): ${result.path}`;
            return c.json({ error }, 409);
          }
        } else {
          const bytes = await readFile(join(workingDirectory, result.path));
          return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
            'content-type': mime,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          });
        }
      }
      return c.json({
        type: 'file' as const,
        path: result.path,
        size: result.size,
        binary: result.binary,
        tooLarge: result.tooLarge,
        ...(result.content !== undefined ? { content: result.content } : {}),
      });
    })

    .post('/runs/:id/git/commit', jsonZodValidator(gitCommitSchema), async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'mutate');
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const parsed = { data: c.req.valid('json') };
      const result = await commitAll(checkout.directory, parsed.data.message);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ committed: true, sha: result.sha });
    })

    .post('/runs/:id/git/push', async (c) => {
      const { root: repoRoot } = c.get('project');
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'mutate');
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { run } = checkout;
      const result = await pushCurrentBranch(checkout.directory);
      if (!result.ok) return c.json({ error: result.error }, 409);
      const repoBase = forgeWebRoot((await getRepoInfo(repoRoot))?.remote) ?? undefined;
      resolveForgeRoot(repoRoot, deps.forgeFactory).branchPushed(ownPullRequestNumbers(run, repoBase));
      return c.json({
        pushed: true,
        branch: result.branch,
        remote: result.remote,
        upstreamSet: result.upstreamSet,
      });
    })

    // Draft PR from the review gate (spec 009): final autosave → push →
    // `gh pr create --draft`; on success the run completes as done with the PR
    // badge. Failures come back as 409 with a `manual` merge command the GUI
    // shows next to the toast. CEZ_DRY_RUN=1 fakes the URL (no push, no gh).
    .post('/runs/:id/pr', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const checkout = runCheckout(c.get('project'), id, 'publish');
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { release } = checkout;
      try {
        const prepared = await preparePublishCheckout(c.get('project'), id);
        if ('status' in prepared) return c.json(prepared.body, prepared.status);
        const { run } = prepared;
        const outcome = await resolveForgeRoot(repoRoot, deps.forgeFactory).createPR({
          repoRoot,
          run,
          handoffText: readHandoff(store.claims.sourceDataDir(id), id),
        });
        if (!outcome.ok) {
          return c.json({ error: outcome.error, manual: `git merge ${run.branch}` }, 409);
        }
        store.move(id, 'draft-pr', { pullRequestUrl: outcome.url });
        store.eventLog.appendEvent(id, {
          type: 'note',
          message: `draft PR created: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
        });
        return c.json({ url: outcome.url, dryRun: outcome.dryRun }, 201);
      } finally {
        release();
      }
    })

    // Archived tasks keep their worktree for inspection; this is the explicit
    // "🧹 Remove worktree" cleanup (spec 006).
    .post('/runs/:id/remove-worktree', protectFallbackRun('worktree'), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const checkout = runCheckout(c.get('project'), id, 'remove', {
        claim: 'publish', checksActive: true, deletion: 'worktree',
        nullClaimError: 'worktree cleanup pending — retry after cleanup is confirmed',
      });
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { run, release } = checkout;
      try {
        if (run.worktreePath) await releaseThenRemoveWorktree({ previewHost: deps.previewHost }, id, repoRoot, run.worktreePath, run.branch);
        store.updateRun(id, { worktreePath: undefined, branch: undefined });
        return c.json({ removed: true });
      } finally { release(); }
    })

    .delete('/runs/:id', protectFallbackRun('record'), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const checkout = runCheckout(c.get('project'), id, 'remove', {
        claim: 'publish', checksActive: true, deletion: 'record',
        nullClaimError: 'worktree cleanup pending — retry after cleanup is confirmed',
      });
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { run, release } = checkout;
      try {
        if (run.delegation?.role !== 'worker' && run.worktreePath) await releaseThenRemoveWorktree({ previewHost: deps.previewHost }, id, repoRoot, run.worktreePath, run.branch);
        return store.retention.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'history cleanup incomplete — retry deletion' }, 409);
      } finally { release(); }
    });

  const openTargetsRoutes = createOpenTargetsRoutes({ capabilities, openApp });

  // Agent screenshots and user attachments — what the run manager persisted out of tool
  // results and pasted messages (`persistAttachment`). `basename` pins reads inside the
  // run's own dir.
  const IMAGE_TYPES: Record<string, string> = {
    img: 'application/octet-stream', // Legacy catch-all image uploads retain inline headers.
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  /**
   * What a NON-image attachment is served as (#950). These are user-supplied bytes coming back
   * from the cockpit's own origin, so the content type is the narrowest true one and it never
   * travels alone: `nosniff` stops a browser from upgrading it to something executable, and an
   * attachment disposition stops it from being rendered as a document in the cockpit's origin at
   * all. Anything not named here keeps the pre-existing `application/octet-stream` default.
   */
  const FILE_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8',
  };
  const worktreesRoutes = createWorktreesRoutes({ home: deps.home, previewHost: deps.previewHost });

  const sseRoutes = createSseRoutes();

  const workspaceEventsRoutes = createWorkspaceEventsRoutes({
    serverGeneration,
    resolveBootProject,
    workspaceRunFeed,
    workspaceEvents,
  });

  const githubRoutes = createGithubRoutes({ forgeFactory: deps.forgeFactory, resolveProjectForge });

  const repoRoutes = createRepoRoutes({ home: deps.home, forgeFactory: deps.forgeFactory, branchForge: deps.branchForge });

  const configRoutes = createConfigRoutes({ home: deps.home, capabilities, archiveOnMergeChanged: deps.archiveOnMergeChanged });
  const agentConfigRoutes = createAgentConfigRoutes(capabilities);
  const agentWebhooksRoutes = createAgentWebhooksRoutes({ home: deps.home, taskWebhooks, taskWebhookFetch: deps.taskWebhookFetch });

  const v1 = new Hono<ProjectApiEnv>()
    .use('*', resolveProjectScope)
    .route('/', skillsRoutes)
    .route('/', uiStateRoutes)
    .route('/', workflowsRoutes)
    .route('/', planRoutes)
    .route('/', automationsRoutes)
    .route('/', agentWebhooksRoutes)
    .route('/', runsRoutes)
    .route('/', reportsRoutes)
    // Team skill sources (hearsay-tools/cezarion#279): settings administration, read-only remotely.
    .route('/', openTargetsRoutes)
    .route('/', worktreesRoutes)
    .route('/', sseRoutes)
    .route('/', githubRoutes)
    .route('/', repoRoutes)
    .route('/', configRoutes)
    .route('/', agentConfigRoutes);
  projectRoutePaths = new Set(v1.routes.filter((route) => route.method !== 'ALL')
    .flatMap((route) => [V1_PREFIX, V1_SCOPED_PREFIX].map((prefix) => `${route.method} ${prefix}${route.path}`)));

  const runsIndexRoutes = createRunsIndexRoutes({
    loadPreparedProjects: (projects) => prepareProjects(projects, { ownership: deps.ownership, homes: [deps.home] }),
    forgeFactory: deps.forgeFactory,
    bootContext,
    contexts,
    workspaceProjects,
    workspaceRunFeed,
    serverGeneration,
    withLiveUsage,
  });

  // Workspace-level families answer for the whole workspace, so they are single-mount: never a
  // project-scoped spelling, which would be a second surface to protect with no consumer.
  const liveRoutes = createWorkspaceLiveRoutes({ serverGeneration, resolveBootProject,
    projectFailure: workspaceProjects.projectFailure,
    resolveProject: (id) => workspaceProjects.resolveLiveProject(id),
  }, { ...deps, localHandoff: () => capabilities().localHandoff });
  const workspaceV1 = new Hono()
    .route('/', liveRoutes)
    .route('/', healthRoutes).route('/', createRunnersRoutes({ home: deps.home, settingsAdmin: () => capabilities().settingsAdmin }))
    .route('/', createModelsRoutes({ capabilities, resolveWorkspaceProfile, modelCatalog, hostedProfileRefusal }))
    .route('/', providersRoutes)
    .route('/', createProviderSignInRoutes({ settingsAdmin: () => capabilities().settingsAdmin, resolve: resolveWorkspaceProfile, auth: providerAuth, invalidateModels: invalidateHostModels }))
    .route('/', projectsRoutes)
    .route('/', agentProfilesRoutes)
    .route('/', workspaceConfigRoutes)
    .route('/', fsBrowseRoutes)
    .route('/', automationChecksRoutes)
    .route('/', runsIndexRoutes)
    .route('/', createActivityRoutes({ bootContext, contexts, workspaceProjects, toolActivity: deps.toolActivity, socketHub: deps.socketHub, workspaceEvents }))
    .route('/', workspaceEventsRoutes);

  // ---- mount ---------------------------------------------------------------
  // Scoped first, then the unscoped alias bound to the boot project. The paths are disjoint (no
  // route starts with `/p/`), so order between the two never decides a match — but the SPA
  // catch-all below must still come last. `route()` re-registers the sub-app's routes under
  // each prefix, handlers shared, internal order preserved.
  //
  // Workspace families mount LAST and that is load-bearing: mounting the project table also
  // mounts its `use('*')` scope resolver over the whole prefix, and Hono runs matched middleware
  // in registration order. `/health` in particular answers for the workspace, has no project to
  // resolve, and is the CORS-open discovery route — it must not sit behind the resolver.
  const routed = app
    .route(V1_SCOPED_PREFIX, v1)
    .route(V1_PREFIX, v1)
    .route(V1_PREFIX, workspaceV1);

  // ---- SPA catch-all -------------------------------------------------------
  // Last, so every route above still wins. Any other GET gets the cockpit shell:
  // react-router owns the route map, including the 404, so `/tasks/:id/changes`
  // cold-loads and survives a refresh instead of 404ing. `/api/*` and the static
  // files above resolve to `passthrough` and fall through to Hono's own 404 —
  // an unknown API path must never answer with HTML.
  // Without a web/dist build this serves the built-in build-hint page (dev-only
  // state — the published tarball ships web/dist), never a 404.
  routed.get('*', async (c) => await serveShell(c) ?? c.notFound());

  return routed;
}

/** The host a thread link names (#589): the bound one, or loopback for a wildcard bind. */
/** The built-in skills a project's manager offers (#774). Test apps inject partial managers. */


export { cockpitOriginFor } from './server-deps.ts';



/**
 * Validate topic-bus upgrades before handshake. Local Host must be loopback. Same-authority or
 * native clients are trusted; verified dev proxies are trusted. Metadata-free foreign loopback
 * origins are untrusted and may read only loopbackReadable topics.
 */
export function verifyWsUpgrade(req: IncomingMessage, bindHost?: string): WsUpgradeVerdict {
  const host = req.headers.host;
  const hostName = hostnameOfHost(host);
  const hosted = !resolveCapabilities(process.env, bindHost).localHandoff;
  if (!hosted && !isLoopbackHostHeader(hostName)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return { trusted: true }; // non-browser client — no Origin to spoof
  // Scheme-checked, like the HTTP guard's comparison: `authorityOfOrigin` is
  // null for anything that is not an http(s) URL, so the opaque `"null"` origin
  // of a sandboxed iframe AND a `ftp://127.0.0.1`-shaped one both stay out
  // rather than reaching the loopback test below on hostname alone.
  const originAuthority = authorityOfOrigin(origin);
  const originHost = hostnameOfOrigin(origin);
  if (originAuthority === null || !originHost) return false;
  if (originAuthority === authorityOfHost(host)) return { trusted: true }; // the cockpit itself
  // The dev-proxy fallback. An explicit `cross-site`/`same-site` is an attacker
  // page on another local port and is refused even though both ends are
  // loopback; anything else needs loopback on both ends to get in at all.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  if (!isLoopbackHostHeader(originHost) || !isLoopbackHostHeader(hostName)) return false;
  // Loopback on both ends, admitted. If the browser vouches it is same-origin
  // (`Sec-Fetch-Site: same-origin`, unforgeable by page JS), this is the dev
  // proxy on Chromium → trust it. An ABSENT header is a browser that ships no
  // metadata (Safari/Firefox), where the dev proxy and a foreign local page are
  // indistinguishable: admit as UNTRUSTED so only `loopbackReadable` topics show.
  return { trusted: fetchSite === 'same-origin' };
}

function resolveWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/server (built) or <pkg>/src/server (tsx dev).
  return join(here, '..', '..', 'web');
}
