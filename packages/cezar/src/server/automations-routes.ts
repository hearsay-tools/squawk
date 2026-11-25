import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import {
  automationCheckRequestSchema,
  automationCreateSchema,
  automationLogQuerySchema,
  automationUpdateSchema,
} from '@open-mercato/cezar-contract/automation-requests';
import { automationListQuerySchema } from '@open-mercato/cezar-contract/automations';
import { localTimeZone } from '@open-mercato/cezar-contract/zoned-time';
import { GithubPoller } from '../automations/github-poller.ts';
import { githubRepository } from '../automations/github-repository.ts';
import type { ScheduleRunnerHandle } from '../automations/schedule-runner.ts';
import { ProjectAutomationScheduler } from '../automations/scheduler.ts';
import { createAutomationService, onceCreateAnswer } from '../automations/service.ts';
import { launchAutomationRun, launchScheduledRun, reconcileAutomationReceipts } from '../automations/task-template.ts';
import { createAutomationToolService } from '../automations/tool-adapter.ts';
import { isGithubAutomation } from '../automations/types.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import type { Home } from '../home/home.ts';
import { retryAutomationLogReceipt } from './automation-log-retry.ts';
import { withProjectAdmission } from './cockpit-ownership.ts';
import type { resolveForge } from './forge/index.ts';
import { getRepoInfo } from './git.ts';
import type { ProjectContext, ProjectContexts } from './project-context.ts';
import type {
  ProjectApiEnv,
  ProviderStatusBundle,
  ServerCapabilitiesFn,
  WorkspaceEventBus,
} from './server-types.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

const AUTOMATIONS_OFF = 'Automations are disabled — unset CEZ_AUTOMATIONS or set it to 1 and restart to enable them';

type ManualCheck = {
  id: string;
  automationId: string;
  mode: 'preview' | 'execute';
  status: 'queued' | 'running' | 'complete' | 'error';
  createdAt: string;
  completedAt?: string;
  matches?: number;
  truncated?: boolean;
  error?: string;
};

export interface AutomationsRouteDeps {
  home: Home;
  capabilities: ServerCapabilitiesFn;
  modelCatalog: RunnerModelCatalog;
  providerStatus: ProviderStatusBundle['providerStatus'];
  bootContext: ProjectContext;
  contexts: ProjectContexts;
  workspaceEvents: WorkspaceEventBus;
  automationsChanged: () => void;
  resolveProjectForge: (info: Awaited<ReturnType<typeof getRepoInfo>>) => ReturnType<typeof resolveForge>;
}

export function createAutomationsRouteBundles(deps: AutomationsRouteDeps) {
  const {
    home,
    capabilities,
    modelCatalog,
    providerStatus,
    bootContext,
    contexts,
    workspaceEvents,
    automationsChanged,
    resolveProjectForge,
  } = deps;

  const emitAutomationChange = (
    project: ProjectContext,
    automationId: string,
    revision: number,
    deleted = false,
  ) => workspaceEvents.emit('automation-change', {
    project: project.id,
    automationId,
    revision,
    ...(deleted ? { deleted: true } : {}),
  });

  const manualChecks = new Map<string, ManualCheck>();

  const requireAutomations = async (c: Context, next: Next) => {
    if (!capabilities().automations) return c.json({ error: AUTOMATIONS_OFF }, 409);
    await next();
  };

  const scheduleHandle = (project: ProjectContext): ScheduleRunnerHandle => {
    const timeZone = localTimeZone();
    return {
      projectId: project.id,
      store: project.automationStore,
      timeZone,
      launch: (definition, occurrence, receiptId) => launchScheduledRun({
        root: project.root,
        manager: project.manager,
        store: project.store,
        definition,
        occurrence,
        receiptId,
        projectName: basename(project.root),
        timeZone,
      }),
      onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
      reconcile: async () => { reconcileAutomationReceipts(project.automationStore, project.store); },
    };
  };

  const automationService = createAutomationService({
    home,
    timeZone: localTimeZone,
    discovery: { models: modelCatalog, providers: () => providerStatus() },
    scheduleHandle: (project) => scheduleHandle(project as ProjectContext),
    emitChange: (project, automationId, revision, deleted) => emitAutomationChange(project as ProjectContext, automationId, revision, deleted),
    changed: automationsChanged,
    githubAvailability: async (root) => {
      const forge = resolveProjectForge(await getRepoInfo(root));
      return forge ? forge.detect() : { available: false, reason: 'No GitHub remote is configured' };
    },
    hasGithubRemote: async (root) => Boolean(resolveProjectForge(await getRepoInfo(root))),
  });

  const attachAutomationTools = (project: ProjectContext) => project.manager.setAutomationTools?.(
    createAutomationToolService(automationService, project, { timeZone: localTimeZone }),
  );
  attachAutomationTools(bootContext);
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) attachAutomationTools(ctx);
  }
  contexts.onContextBuilt(attachAutomationTools);

  const automationsRoutes = new Hono<ProjectApiEnv>()
    .use('/automations', requireAutomations)
    .use('/automations/*', requireAutomations)
    .use('/automation-log', requireAutomations)
    .use('/automation-log/*', requireAutomations)
    .get('/automations', queryZodValidator(automationListQuerySchema), async (c) => {
      return c.json(await automationService.list(c.get('project'), c.req.valid('query')));
    })

    .post('/automations', jsonZodValidator(() => automationCreateSchema, { runners: { ids: ['task.runner', 'task.steps.*.runner'] } }), async (c) => {
      const result = await automationService.create(c.get('project'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const once = onceCreateAnswer(result.automation);
      return c.json({ automation: result.automation, ...(once ? { once } : {}) }, 201);
    })

    .get('/automations/:id', (c) => {
      const result = automationService.get(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(result.body);
    })

    .put('/automations/:id', jsonZodValidator(() => automationUpdateSchema, { runners: { ids: ['task.runner', 'task.steps.*.runner'] } }), async (c) => {
      const result = await automationService.update(c.get('project'), c.req.param('id'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .delete('/automations/:id', async (c) => {
      const result = await automationService.remove(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.body(null, 204);
    })

    .post('/automations/:id/enable', async (c) => {
      const result = await automationService.enable(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .post('/automations/:id/pause', async (c) => {
      const result = await automationService.pause(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .post('/automations/:id/cancel', async (c) => {
      const result = await automationService.cancel(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .post('/automations/:id/run', async (c) => {
      const result = await automationService.runNow(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ runId: result.runId }, 202);
    })

    .post('/automations/:id/check', jsonZodValidator(() => automationCheckRequestSchema), async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const automation = store.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      if (!isGithubAutomation(automation)) return c.json({ error: 'a schedule has nothing to preview; use run' }, 409);
      const parsed = { data: c.req.valid('json') };
      const id: string = randomUUID();
      const check: ManualCheck = { id, automationId: automation.id, mode: parsed.data.mode, status: 'queued', createdAt: new Date().toISOString() };
      if (manualChecks.size >= 200) manualChecks.delete(manualChecks.keys().next().value!);
      manualChecks.set(id, check);
      void withProjectAdmission(project.dataDir, async function manualCheck() {
        check.status = 'running';
        try {
          const repository = githubRepository(project.root, (await getRepoInfo(project.root))?.remote);
          if (!repository) throw new Error('No GitHub remote is configured');
          const scheduler = new ProjectAutomationScheduler({
            projectId: project.id,
            store,
            timeZone: localTimeZone(),
            github: { ...repository, poller: new GithubPoller() },
            launch: parsed.data.mode === 'execute'
              ? (definition, candidate, receiptId) => launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate, receiptId })
              : undefined,
            onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
          });
          const result = await scheduler.check(automation, parsed.data.mode);
          Object.assign(check, { status: 'complete', completedAt: new Date().toISOString(), matches: result.candidates.length, truncated: result.truncated });
        } catch (error) {
          Object.assign(check, { status: 'error', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
        }
      }, (error) => { Object.assign(check, { status: 'error', completedAt: new Date().toISOString(), error: error.message }); });
      return c.json({ checkId: id }, 202);
    })

    .get('/automation-log', queryZodValidator(automationLogQuerySchema), (c) => {
      return c.json({ records: c.get('project').automationStore.logs(c.req.valid('query')) });
    })

    .post('/automation-log/:receiptId/retry', async (c) => {
      const result = await retryAutomationLogReceipt({
        project: c.get('project'),
        receiptId: c.req.param('receiptId'),
        scheduleHandle,
        emitChange: emitAutomationChange,
      });
      if (result.status === 202) return c.json(result.body, 202);
      return result.status === 404 ? c.json(result.body, 404) : c.json(result.body, 409);
    });

  const automationChecksRoutes = new Hono()
    .use('/automation-checks/*', requireAutomations)
    .get('/automation-checks/:checkId', (c) => {
      const check = manualChecks.get(c.req.param('checkId'));
      return check ? c.json(check) : c.json({ error: 'not found' }, 404);
    });

  return { automationsRoutes, automationChecksRoutes };
}
