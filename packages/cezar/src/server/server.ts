import type { RunnerSkillCatalog } from '../core/runner-skill-catalog.ts';
import { projectPaths } from '../project-paths.ts';
import { reportsRoutes } from './reports-api.ts';
export type { WorkspaceConfigResponse } from '@open-mercato/cezar-contract';
import { CheckoutProgressCache } from './checkout-progress.ts';
import { createWorkspaceLiveRoutes } from './workspace-live-routes.ts';
import { createActivityRoutes, type ActivityServerDeps } from './activity-routes.ts';
import { createRunnersRoutes } from './runners-routes.ts';
import type { Home } from '../home/home.ts';
import { createWorkspaceProjects, createWorkspaceProjectContexts, createTaskWebhooks, type WorkspaceProjects } from './workspace-projects.ts';
import { type WorkerCleanupFactory } from '../delegation/service.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../automations/store.ts';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { matchedRoutes } from 'hono/route';
import { TaskWebhooks } from '../runs/webhook.ts';
// A contract VALUE, like `workspaceUiStateSchema` in workspace/migrations.ts — the request
// schema this route validates with is the same one the client compiles against.
import { registeredRunners } from '../core/runner-registry.ts';
import type { HttpRouteDefinition } from '../core/http-route-registry.ts';
import { mountPluginHttpRoutes } from './plugin-http-routes.ts';
import { environmentStamp, type detectEnvironment } from '../core/backend-detect.ts';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { createModelsRoutes } from './models-routes.ts';
import { createProviderSignInRoutes } from './provider-sign-in-routes.ts';
import { allUsage, onUsage } from '../core/process-usage.ts';
import type { RunStore } from '../runs/store.ts';
import { getRepoInfo, type RepoInfo } from './git.ts';
import { createHealthCache, HEALTH_TTL_MS } from './health-cache.ts';
import { authorityOfHost, authorityOfOrigin, hostnameOfHost, hostnameOfOrigin } from './host-authority.ts';
import { pluginHealth, pluginLoadReport } from '../plugin/loader.ts';
import { createBackendChecks } from './backend-checks.ts';
import { type BranchForge } from './repo-branches.ts';
import { healthConfig } from '../config.ts';
import { defaultWorkspaceConfig, loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, defaultAgentAccountStore, loadAgentAccounts, type AgentAccount } from '../workspace/agent-accounts.ts';
import { defaultAgentProfile, listAgentProfiles, resolveStoredProfile, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { type CloneRunner } from './checkout.ts';
import { type CommandRunner } from './create-project.ts';
import { createWorkspaceRunFeed } from './workspace-run-feed.ts';
import { ProjectContexts, type ProjectContext, type ProjectRunManager, type RunManagerFactory } from './project-context.ts';

import { isLoopbackHostHeader, resolveCapabilities } from './capabilities.ts';
import type { SocketHub, WsUpgradeVerdict } from './ws.ts';
import type { PreviewHost } from '../preview/host.ts';
import { resolveForge, type ForgeFactory } from './forge/index.ts';
import { withProjectAdmission, type CockpitOwnership } from './cockpit-ownership.ts';
import { prepareProjects } from '../project-migration/auto.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import { attachProjectWebhooks, createBootContext, createProviderStatus, resolveServerDeps, watchProviderRuntimeAuth } from './server-deps.ts';
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
import { WorkspaceEventBus, type ProjectApiEnv } from './server-types.ts';
import { createAutomationsRouteBundles } from './automations-routes.ts';
import { createGithubRoutes } from './github-routes.ts';
import { createOpenTargetsRoutes, createRepoRoutes, createWorktreesRoutes } from './repo-routes.ts';
import { createFsBrowseRoutes, createRunsIndexRoutes, createWorkspaceConfigRoutes, createWorkspaceEventsRoutes } from './workspace-routes.ts';
import { createSessionContextRoutes } from './session-context-routes.ts';
import { createAgentConfigRoutes, createAgentWebhooksRoutes, createConfigRoutes, createPlanRoutes, createSkillsRoutes, createSseRoutes, createUiStateRoutes, createWorkflowsRoutes } from './project-settings-routes.ts';
import { createRunsRoutes, withLiveUsage } from './runs-routes.ts';
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
  /** Non-RPC plugin HTTP routes override for isolated tests; defaults to sealed `registeredHttpRoutes()`. */
  httpRoutes?: readonly HttpRouteDefinition[] | undefined;
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

// These response shapes belong to the contract; keep the server's existing type exports.
export type { ProjectsResponse, RegisterProjectResponse, RemoveProjectResponse, UpdateProjectResponse } from '@open-mercato/cezar-contract';

// ---- workspace SSE (multi-project spec, step 2.8) --------------------------


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
   */
  const warmAgentKnowledge = async (): Promise<void> => {
    await providerAuth.status().catch(() => {});
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
    bootRoot,
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
  const skillsRoutes = createSkillsRoutes({ home: deps.home, skillCatalog, resolveWorkspaceProfile });
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


  // One run feed for every workspace stream connection (hearsay-tools/cezarion#2730): one store
  // subscription per project, one process-wide `seq`, each frame built once per mode.
  const workspaceRunFeed = createWorkspaceRunFeed({
    bootStore: bootContext.store, contexts, onWorkspaceEvent: (listener) => workspaceEvents.on(listener),
    onUsage, allUsage, withLiveUsage,
  });

  const runsRoutes = createRunsRoutes({
    home: deps.home,
    forgeFactory: deps.forgeFactory,
    delegation: deps.delegation,
    workerCleanup: deps.workerCleanup,
    previewHost: deps.previewHost,
    capabilities,
    modelCatalog,
    providerStatus,
    providerActionError,
    resolveWorkspaceProfile,
    projectRegistryEntry,
    taskWebhooks,
    openTerminal,
    openFile,
    openApp,
  });

  const openTargetsRoutes = createOpenTargetsRoutes({ capabilities, openApp });

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
    .route('/', agentConfigRoutes)
    .route('/', createSessionContextRoutes());
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
    .route('/', createModelsRoutes({ resolveWorkspaceProfile, modelCatalog }))
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

  mountPluginHttpRoutes({
    routed,
    home: deps.home,
    version,
    squawkPort: deps.squawkPort,
    isHostedMode,
    httpRoutes: deps.httpRoutes,
  });

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
