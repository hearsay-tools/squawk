import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import type {
  ProjectWebhookResponse,
  ProjectsResponse,
  RegisterProjectResponse,
  RemoveProjectResponse,
  TestProjectWebhookResponse,
  UpdateProjectResponse,
} from '@open-mercato/cezar-contract';
import { PROJECT_WEBHOOKS_MAX } from '@open-mercato/cezar-contract/project-limits';
import {
  checkoutProjectInputSchema as checkoutSchema,
  checkoutProgressParamsSchema,
  createProjectInputSchema,
  createProjectWebhookInputSchema,
  projectWebhookParamsSchema,
  registerProjectInputSchema as registerProjectSchema,
  updateProjectInputSchema,
  updateProjectWebhookInputSchema,
  type CreateProjectResponse,
  type GithubOwnersResponse,
} from '@open-mercato/cezar-contract/projects';
import { defined } from '../core/defined.ts';
import { isAbsoluteHostPath } from '../core/host-path.ts';
import { productEnv } from '../core/product-env.ts';
import type { Home } from '../home/home.ts';
import { expandTilde } from '../paths.ts';
import type { RunStatus } from '../runs/store.ts';
import { deliverOnce } from '../runs/webhook.ts';
import {
  defaultWorkspaceConfig,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  type StoredProjectWebhook,
  type WorkspaceProject,
} from '../workspace/config.ts';
import {
  normalizeProjectTags,
  probeProjectStatus,
  registerProject,
  removeProject,
  shouldRegisterProject,
  toProjectListEntry,
  type ProjectListEntry,
} from '../workspace/projects.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  applyTaskWebhookInput,
  createdWebhook,
  editedWebhook,
  nameTaken,
  projectWebhooks,
  redactWebhook,
  setProjectWebhooks,
  taskWebhooks as taskWebhookList,
} from '../workspace/webhooks.ts';
import { checkoutRepo, type CloneRunner } from './checkout.ts';
import type { CheckoutProgressCache } from './checkout-progress.ts';
import { createProject, listGithubOwners, type CommandRunner } from './create-project.ts';
import { isInsideBrowseRoot, isLexicallyInsideBrowseRoot, resolveBrowseRoot } from './fs-browse.ts';
import type { ProjectContexts } from './project-context.ts';
import {
  writeErrorMessage,
  type ProjectApiEnv,
  type ServerCapabilitiesFn,
  type WorkspaceEventBus,
} from './server-types.ts';
import { NO_WEBHOOK_ERROR } from './start-run-options.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

const HOSTED_GITHUB_CREATE_REFUSAL = 'Creating GitHub repositories is available from a local cockpit only';
const HOSTED_GITHUB_OWNERS_REASON = 'GitHub repositories can be created from a local cockpit only';
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting']);

const webhookNameTakenError = (name: string) =>
  `this project already has a webhook named "${name.trim()}" — pick another name`;

export interface ProjectsRouteDeps {
  home: Home;
  capabilities: ServerCapabilitiesFn;
  contexts: ProjectContexts;
  workspaceProjects: WorkspaceProjects;
  workspaceEvents: WorkspaceEventBus;
  checkoutProgress: CheckoutProgressCache;
  semaphore?: WorkspaceSemaphore | undefined;
  taskWebhookFetch?: typeof fetch | undefined;
  cloneRunner?: CloneRunner | undefined;
  projectCommandRunner?: CommandRunner | undefined;
  workspaceBrowseRoot: () => Promise<string>;
}

export function createProjectsRoutes(deps: ProjectsRouteDeps) {
  const {
    home,
    capabilities,
    contexts,
    workspaceProjects,
    workspaceEvents,
    checkoutProgress,
    workspaceBrowseRoot,
  } = deps;
  const { resolveBootProject } = workspaceProjects;

  const workspaceProjectsDir = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig(home.workspaceConfig)).projectsDir;
    } catch {
      return defaultWorkspaceConfig().projectsDir;
    }
  };

  const sendTestDelivery = async (projectId: string, webhook: StoredProjectWebhook): Promise<TestProjectWebhookResponse> => {
    if (productEnv('DRY_RUN') === '1') return { ok: true, dryRun: true };
    const payload = {
      event: 'task.test' as const,
      deliveryId: randomUUID(),
      projectId,
      webhook: { id: webhook.id, name: webhook.name },
      occurredAt: new Date().toISOString(),
    };
    const result = await deliverOnce(webhook, payload, { fetch: deps.taskWebhookFetch });
    return {
      ok: result.ok,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };

  type WebhookEdit =
    | { webhooks: StoredProjectWebhook[]; webhook: StoredProjectWebhook }
    | { error: string; status: 404 | 409 };

  const editProjectWebhooks = async (
    raw: string,
    edit: (webhooks: StoredProjectWebhook[]) => WebhookEdit,
  ): Promise<{ body: ProjectWebhookResponse } | { error: string; status: 400 | 404 | 409 | 500 }> => {
    const resolved = await workspaceProjects.resolveProjectId(raw);
    if ('error' in resolved) return { ...resolved, status: 404 };
    const { id } = resolved;
    const known = await loadWorkspaceConfig(home.workspaceConfig).then((config) => config.projects.some((p) => p.id === id), () => false);
    if (!known) return { error: `unknown project: ${id}`, status: 404 };
    let updated: WorkspaceProject | undefined;
    let outcome: WebhookEdit | undefined;
    try {
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.id === id);
        if (!entry) return;
        outcome = edit([...projectWebhooks(entry)]);
        if ('error' in outcome) return;
        setProjectWebhooks(entry, outcome.webhooks);
        updated = entry;
      }, home);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), status: 500 };
    }
    if (outcome && 'error' in outcome) return outcome;
    if (!updated || !outcome) return { error: `unknown project: ${id}`, status: 404 };
    return {
      body: {
        project: toProjectListEntry(updated, await probeProjectStatus(updated.root)),
        webhook: redactWebhook(outcome.webhook),
      },
    };
  };

  const isInsideHostedBrowseRoot = async (candidate: string): Promise<boolean> => {
    const browseRoot = resolveBrowseRoot(await workspaceBrowseRoot());
    if (!(await isLexicallyInsideBrowseRoot(browseRoot, candidate))) return false;
    let existing = candidate;
    while (!(await stat(existing).then(() => true, () => false))) {
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    return isInsideBrowseRoot(browseRoot, existing);
  };

  const registerFolder = async (
    spelled: string,
    source: 'local' | 'checkout',
  ): Promise<
    | { status: 200; body: RegisterProjectResponse; existing: boolean }
    | { status: 400 | 500; body: { error: string } }
  > => {
    const requested = expandTilde(spelled);
    if (!isAbsoluteHostPath(requested)) {
      return {
        status: 400,
        body: { error: `not a folder: ${spelled} is not an absolute path` },
      };
    }
    const hostedBrowseRoot = capabilities().localHandoff
      ? null
      : resolveBrowseRoot(await workspaceBrowseRoot());
    if (hostedBrowseRoot !== null) {
      if (!(await isLexicallyInsideBrowseRoot(hostedBrowseRoot, requested))) {
        return {
          status: 400,
          body: { error: 'folder is outside the browsable root' },
        };
      }
    }
    const info = await stat(requested).catch(() => null);
    if (!info?.isDirectory()) return { status: 400, body: { error: `no such folder: ${spelled}` } };
    if (hostedBrowseRoot !== null && !(await isInsideBrowseRoot(hostedBrowseRoot, requested))) {
      return {
        status: 400,
        body: { error: 'folder is outside the browsable root' },
      };
    }
    if (!(await shouldRegisterProject(requested))) {
      return {
        status: 400,
        body: {
          error: `not a project folder: ${spelled} is your home directory or a Squawk task worktree`,
        },
      };
    }
    const real = await realpath(requested).catch(() => requested);
    let known = false;
    try {
      known = (await loadWorkspaceConfig(home.workspaceConfig)).projects.some((p) => p.root === real);
    } catch {
      // unreadable workspace — treat as unknown; the write below will fail loudly
    }
    let project: ProjectListEntry;
    try {
      const entry = await registerProject(requested, source, home);
      project = toProjectListEntry(entry, await probeProjectStatus(entry.root));
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    if (!known) workspaceEvents.emit('project-added', { project });
    return { status: 200, body: { project }, existing: known };
  };

  const activeRunCount = (projectId: string): number => {
    const ctx = contexts.peek(projectId);
    if (!ctx) return 0;
    return ctx.store.queries.listRuns().filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  };

  const recordCheckoutProgress = (event: Parameters<CheckoutProgressCache['record']>[0]) => {
    checkoutProgress.record(event);
    workspaceEvents.emit('checkout-progress', event);
  };

  const checkoutFailureBody = (result: { error: string; reason?: string }) =>
    'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error };

  return new Hono<ProjectApiEnv>()
    .get('/projects', async (c) => {
      let projects: ProjectListEntry[] = [];
      let projectsDir = defaultWorkspaceConfig().projectsDir;
      try {
        projectsDir = (await loadWorkspaceConfig(home.workspaceConfig)).projectsDir;
        projects = await workspaceProjects.listProjects();
      } catch {
        // unreadable workspace — degrade to the empty registry + defaults
      }
      const body: ProjectsResponse = {
        projects,
        bootProject: await resolveBootProject(projects),
        projectsDir,
      };
      return c.json(body);
    })

    .post('/projects', jsonZodValidator(() => registerProjectSchema, { message: 'root must be a non-empty path' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const registered = await registerFolder(parsed.data.root, 'local');
      if (registered.status !== 200) return c.json(registered.body, registered.status);
      if (registered.existing) {
        const { project } = registered.body;
        return c.json({ project, error: `already registered as ${project.id}` }, 409);
      }
      return c.json(registered.body, 200);
    })

    .delete('/projects/:projectId', async (c) => {
      const raw = c.req.param('projectId');
      const resolved = await workspaceProjects.resolveProjectId(raw, true);
      if ('error' in resolved) return c.json(resolved, 404);
      const { id, bootId } = resolved;

      let entry: WorkspaceProject | undefined;
      try {
        entry = (await loadWorkspaceConfig(home.workspaceConfig)).projects.find((p) => p.id === id);
      } catch {
        // unreadable workspace
      }
      if (!entry) return c.json({ error: `unknown project: ${id}` }, 404);

      if (id === bootId) {
        return c.json(
          {
            error: `Squawk is serving ${entry.name} right now — it re-registers itself at every start, so it cannot be removed from here`,
          },
          409,
        );
      }

      await contexts.settle(id);
      const active = activeRunCount(id);
      if (active > 0) {
        return c.json(
          {
            error: `${entry.name} has ${active} running task${active === 1 ? '' : 's'} — cancel or finish ${active === 1 ? 'it' : 'them'} before removing the project`,
            runningTasks: active,
          },
          409,
        );
      }

      let removed: boolean;
      try {
        removed = await removeProject(id, home);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (!removed) return c.json({ error: `unknown project: ${id}` }, 404);
      contexts.dispose(id);
      workspaceEvents.emit('project-removed', { id });
      const body: RemoveProjectResponse = { removed: true, id };
      return c.json(body);
    })

    .patch('/projects/:projectId', jsonZodValidator(updateProjectInputSchema), async (c) => {
      const raw = c.req.param('projectId');
      const resolved = await workspaceProjects.resolveProjectId(raw);
      if ('error' in resolved) return c.json(resolved, 404);
      const parsed = { data: c.req.valid('json') };
      const { id } = resolved;
      const { maxParallel, tags, webhook } = parsed.data;

      let known = false;
      try {
        known = (await loadWorkspaceConfig(home.workspaceConfig)).projects.some((p) => p.id === id);
      } catch {
        // unreadable workspace
      }
      if (!known) return c.json({ error: `unknown project: ${id}` }, 404);

      let updated: WorkspaceProject | undefined;
      try {
        await mergeWriteWorkspaceConfig((config) => {
          const entry = config.projects.find((p) => p.id === id);
          if (!entry) return;
          if (maxParallel !== undefined) {
            if (maxParallel === null) delete entry.maxParallel;
            else entry.maxParallel = maxParallel;
          }
          if (tags !== undefined) {
            const normalized = normalizeProjectTags(tags);
            if (normalized === undefined) delete entry.tags;
            else entry.tags = normalized;
          }
          if (webhook !== undefined) {
            applyTaskWebhookInput(entry, webhook);
          }
          updated = entry;
        }, home);
      } catch (err) {
        return c.json({ error: writeErrorMessage(err) }, 500);
      }
      if (!updated) return c.json({ error: `unknown project: ${id}` }, 404);

      await deps.semaphore?.refresh();
      const body: UpdateProjectResponse = {
        project: toProjectListEntry(updated, await probeProjectStatus(updated.root)),
      };
      return c.json(body);
    })

    .post('/projects/:projectId/webhook/test', async (c) => {
      const raw = c.req.param('projectId');
      const entry = await workspaceProjects.resolveRegistryEntry(raw);
      if (!entry) return c.json({ error: `unknown project: ${raw}` }, 404);
      const webhook = taskWebhookList(entry)[0];
      if (!webhook) return c.json({ error: NO_WEBHOOK_ERROR }, 400);
      const body: TestProjectWebhookResponse = await sendTestDelivery(entry.id, webhook);
      return c.json(body);
    })

    .post('/projects/:projectId/webhooks', jsonZodValidator(createProjectWebhookInputSchema), async (c) => {
      const input = c.req.valid('json');
      const answer = await editProjectWebhooks(c.req.param('projectId'), (webhooks) => {
        if (webhooks.length >= PROJECT_WEBHOOKS_MAX) return { error: `a project holds at most ${PROJECT_WEBHOOKS_MAX} webhooks`, status: 409 };
        if (nameTaken(webhooks, input.name)) return { error: webhookNameTakenError(input.name), status: 409 };
        const webhook = createdWebhook(webhooks, input);
        return { webhooks: [...webhooks, webhook], webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const body: ProjectWebhookResponse = answer.body;
      return c.json(body, 201);
    })

    .patch('/projects/:projectId/webhooks/:webhookId', paramZodValidator(projectWebhookParamsSchema), jsonZodValidator(updateProjectWebhookInputSchema), async (c) => {
      const { projectId, webhookId } = c.req.valid('param');
      const input = c.req.valid('json');
      const answer = await editProjectWebhooks(projectId, (webhooks) => {
        const index = webhooks.findIndex((webhook) => webhook.id === webhookId);
        if (index < 0) return { error: `unknown webhook: ${webhookId}`, status: 404 };
        if (input.name !== undefined && nameTaken(webhooks, input.name, webhookId)) return { error: webhookNameTakenError(input.name), status: 409 };
        const webhook = editedWebhook(webhooks[index]!, input);
        return { webhooks: webhooks.map((entry, at) => (at === index ? webhook : entry)), webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const body: ProjectWebhookResponse = answer.body;
      return c.json(body);
    })

    .delete('/projects/:projectId/webhooks/:webhookId', paramZodValidator(projectWebhookParamsSchema), async (c) => {
      const { projectId, webhookId } = c.req.valid('param');
      const answer = await editProjectWebhooks(projectId, (webhooks) => {
        const webhook = webhooks.find((entry) => entry.id === webhookId);
        if (!webhook) return { error: `unknown webhook: ${webhookId}`, status: 404 };
        return { webhooks: webhooks.filter((entry) => entry !== webhook), webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const project = answer.body.project;
      const body: UpdateProjectResponse = { project: defined({ ...project, webhook: project.webhook && defined(project.webhook) }) };
      return c.json(body);
    })

    .post('/projects/:projectId/webhooks/:webhookId/test', paramZodValidator(projectWebhookParamsSchema), async (c) => {
      const { projectId, webhookId } = c.req.valid('param');
      const entry = await workspaceProjects.resolveRegistryEntry(projectId);
      if (!entry) return c.json({ error: `unknown project: ${projectId}` }, 404);
      const webhook = projectWebhooks(entry).find((candidate) => candidate.id === webhookId);
      if (!webhook) return c.json({ error: `unknown webhook: ${webhookId}` }, 404);
      const body: TestProjectWebhookResponse = await sendTestDelivery(entry.id, webhook);
      return c.json(body);
    })

    .get('/projects/checkout/:checkoutId/progress', paramZodValidator(checkoutProgressParamsSchema), c => c.json({ progress: checkoutProgress.get(c.req.valid('param').checkoutId) }))

    .post('/projects/checkout', jsonZodValidator(() => checkoutSchema, { message: 'url must be a GitHub repository' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const { url, name, checkoutId } = parsed.data;
      const result = await checkoutRepo({
        url,
        name,
        checkoutId,
        projectsDir: expandTilde(await workspaceProjectsDir()),
        onProgress: recordCheckoutProgress,
        signal: c.req.raw.signal,
        ...(deps.cloneRunner ? { run: deps.cloneRunner } : {}),
      });
      if (!result.ok) {
        return c.json(checkoutFailureBody(result), result.status);
      }
      const registered = await registerFolder(result.target, 'checkout');
      if (registered.status !== 200) {
        return c.json({ error: `${registered.body.error} (the clone is at ${result.target})` }, registered.status);
      }
      return c.json(registered.body, 200);
    })

    .get('/projects/github-owners', async (c) => {
      if (!capabilities().localHandoff) {
        const body: GithubOwnersResponse = { available: false, reason: HOSTED_GITHUB_OWNERS_REASON };
        return c.json(body);
      }
      return c.json(await listGithubOwners(deps.projectCommandRunner));
    })

    .post('/projects/create', jsonZodValidator(() => createProjectInputSchema, { message: 'project name must be a valid GitHub repository name — letters, digits, ".", "-" and "_" only, no spaces' }), async (c) => {
      const { name, github, checkoutId } = c.req.valid('json');
      if (github && !capabilities().localHandoff) {
        return c.json({ error: HOSTED_GITHUB_CREATE_REFUSAL }, 409);
      }
      const projectsDir = expandTilde(await workspaceProjectsDir());
      if (!capabilities().localHandoff && !(await isInsideHostedBrowseRoot(join(projectsDir, name)))) {
        return c.json({ error: 'folder is outside the browsable root' }, 400);
      }
      const result = await createProject({
        name,
        github,
        checkoutId,
        projectsDir,
        onProgress: recordCheckoutProgress,
        signal: c.req.raw.signal,
        ...(deps.projectCommandRunner ? { run: deps.projectCommandRunner } : {}),
      });
      if (!result.ok) {
        return c.json(checkoutFailureBody(result), result.status);
      }
      const registered = await registerFolder(result.target, result.slug ? 'checkout' : 'local');
      if (registered.status !== 200) {
        const warning = result.warning ? `\n${result.warning}` : '';
        return c.json({ error: `${registered.body.error} (the project is at ${result.target})${warning}` }, registered.status);
      }
      const body: CreateProjectResponse = { project: registered.body.project, ...(result.warning ? { warning: result.warning } : {}) };
      return c.json(body, 200);
    });
}
