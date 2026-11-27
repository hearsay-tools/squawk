import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentWebhooksResponse, ConfigResponse, SendAgentReportResponse } from '@open-mercato/cezar-contract';
import { setAgentConfigSchema, setConfigSchema } from '@open-mercato/cezar-contract/config-requests';
import { runEventsQuerySchema, runIdParamSchema } from '@open-mercato/cezar-contract/events';
import { agentWebhookParamsSchema, sendAgentReportInputSchema } from '@open-mercato/cezar-contract/projects';
import { runnerSkillsQuerySchema } from '@open-mercato/cezar-contract/runner-skills';
import { uiStateBody } from '@open-mercato/cezar-contract/ui-state-requests';
import { parseWorkflowSchema, planSchema } from '@open-mercato/cezar-contract/workflow-requests';
import { saveWorkflowInputSchema as saveWorkflowSchema } from '@open-mercato/cezar-contract/workflows';
import { findConfigFile } from '../agent-config/catalog.ts';
import { readConfigFile, writeConfigFile } from '../agent-config/files.ts';
import { readAgentModelDefaults } from '../agent-config/models.ts';
import { listAgentConfig } from '../agent-config/service.ts';
import { resolveArchiveOnMerge } from '../archive-on-merge-setting.ts';
import { loadConfig, type CezConfig } from '../config.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { onUsage } from '../core/process-usage.ts';
import { resolveRunnerId } from '../core/runner-registry.ts';
import type { RunnerSkillCatalog } from '../core/runner-skill-catalog.ts';
import type { Home } from '../home/home.ts';
import { productIdentity } from '../home/identity.ts';
import { planChain, slugify } from '../planner.ts';
import { projectPaths } from '../project-paths.ts';
import { HistoryCursorError, validateLiveCursor } from '../runs/event-history.ts';
import { isV2WireEventType } from '../runs/ui-event-sink.ts';
import { registryEntry, sendAgentReport, type TaskWebhooks } from '../runs/webhook.ts';
import { mergeWriteProjectUiState, readUiState } from '../ui-state.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { normalizeWorkflowDoc, skillStackOf, skillsToSteps, stepsIssue, workflowFileSchema } from '../workflows/types.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { agentWebhook, agentWebhooks } from '../workspace/webhooks.ts';
import { reportWorktreeCommands } from '../worktree-setup.ts';
import { writeMergedConfig } from './config-merge.ts';
import { subscribeRunFeed } from './run-event-feed.ts';
import { readRunnerSkills } from './runner-skills.ts';
import {
  streamSSENoBuffer,
  UI_STATE_BODY_LIMIT,
  type ProjectApiEnv,
  type ProviderStatusBundle,
  type ResolveWorkspaceProfileFn,
  type ServerCapabilitiesFn,
} from './server-types.ts';
import { agentProfileRefusal } from './start-run-options.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { deleteSavedWorkflow } from './workflow-files.ts';
import { currentRecord, type RunWrite } from './workspace-run-feed.ts';

export interface SkillsRouteDeps {
  home: Home;
  skillCatalog: RunnerSkillCatalog;
  resolveWorkspaceProfile: ResolveWorkspaceProfileFn;
}

export function createSkillsRoutes(deps: SkillsRouteDeps) {
  const { home, skillCatalog, resolveWorkspaceProfile } = deps;
  return new Hono<ProjectApiEnv>()
    .get('/runner-skills', queryZodValidator(runnerSkillsQuerySchema, { runners: { ids: ['runner'] } }), async c => {
      const result = await readRunnerSkills(c.req.valid('query'), c.get('project').root, home, skillCatalog, resolveWorkspaceProfile);
      if ('error' in result) return c.json(result, 400);
      return c.json(result);
    });
}

export function createUiStateRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/ui-state', async (c) => c.json(await readUiState(c.get('project').root)))
    .use('/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))
    .put('/ui-state', jsonZodValidator(uiStateBody), async (c) => {
      const patch = c.req.valid('json');
      try {
        return c.json(await mergeWriteProjectUiState(c.get('project').root, (current) => ({ ...current, ...patch })));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
}

export function createWorkflowsRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/workflows', async (c) => c.json(await loadWorkflows(c.get('project').root)))

    .post('/workflows', jsonZodValidator(saveWorkflowSchema, { runners: { ids: ['steps.*.runner'] } }), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const steps = parsed.data.steps ?? skillsToSteps(parsed.data.skills ?? []);
      const issue = stepsIssue(steps);
      if (issue) return c.json({ error: issue }, 400);
      const slug = slugify(parsed.data.name) || 'chain';
      const dir = join(projectPaths(repoRoot).write, 'workflows');
      const path = join(dir, `${slug}.yaml`);
      const stack = skillStackOf(steps);
      const doc = {
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(stack ? { skills: stack } : { steps }),
      };
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(path, stringifyYaml(doc), {
          encoding: 'utf8',
          flag: parsed.data.overwrite ? 'w' : 'wx',
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          return c.json({ error: `workflow file already exists: ${path}`, exists: true }, 409);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
      return c.json({ path, name: parsed.data.name }, 201);
    })

    .delete('/workflows/:name', async (c) => {
      const result = await deleteSavedWorkflow(c.get('project').root, c.req.param('name'));
      if ('error' in result) return c.json({ error: result.error }, result.status);
      return c.json({ ok: true, path: result.path });
    })

    .post('/workflows/parse', jsonZodValidator(parseWorkflowSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      let raw: unknown;
      try {
        raw = parseYaml(parsed.data.yaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `not valid YAML: ${message}` }, 400);
      }
      const doc = workflowFileSchema.safeParse(raw);
      if (!doc.success) {
        return c.json({ error: doc.error.issues.map((i) => i.message).join('; ') }, 400);
      }
      const normalized = normalizeWorkflowDoc(doc.data);
      const issue = stepsIssue(normalized.steps);
      if (issue) return c.json({ error: issue }, 400);
      return c.json(normalized);
    });
}

export interface PlanRouteDeps {
  home: Home;
  skillCatalog: RunnerSkillCatalog;
  providerActionError: ProviderStatusBundle['providerActionError'];
  resolveWorkspaceProfile: ResolveWorkspaceProfileFn;
}

export function createPlanRoutes(deps: PlanRouteDeps) {
  const { home, skillCatalog, providerActionError, resolveWorkspaceProfile } = deps;
  return new Hono<ProjectApiEnv>()
    .post('/plan', jsonZodValidator(planSchema), async (c) => {
      const { root: repoRoot, manager } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const planner = resolveRunnerId((await loadConfig(repoRoot, home)).defaultRunner);
      const blocked = await providerActionError([planner], { repoRoot, picks: { [planner]: parsed.data.agentProfile } });
      if (blocked) return c.json({ error: blocked }, 409);
      const badProfile = await agentProfileRefusal(resolveWorkspaceProfile, planner, parsed.data.agentProfile);
      if (badProfile) return c.json({ error: badProfile.error }, badProfile.status);
      return c.json(await planChain(repoRoot, parsed.data.task, skillCatalog, home, manager.createRunner, parsed.data.agentProfile));
    });
}

export interface ConfigRouteDeps {
  home: Home;
  capabilities: ServerCapabilitiesFn;
  archiveOnMergeChanged?: (() => void) | undefined;
}

export function createConfigRoutes(deps: ConfigRouteDeps) {
  const { home, capabilities } = deps;
  const WORKTREE_COMMANDS_HOSTED_ERROR = `Worktree setup and teardown commands are read-only on this remote cockpit. To allow remote edits, run \`${productIdentity().command} remote-settings enable\` on the machine running Squawk.`;

  const configAnswer = async (repoRoot: string, config: CezConfig): Promise<ConfigResponse> => {
    const archive = resolveArchiveOnMerge(config, await loadWorkspaceConfig(home.workspaceConfig));
    const nativeModels = await readAgentModelDefaults(repoRoot);
    const setup = reportWorktreeCommands(config.worktreeSetup);
    const teardown = reportWorktreeCommands(config.worktreeTeardown);
    const modelsLocked = agentModelsLocked(repoRoot, process.env, home);
    return {
      archiveOnMerge: config.archiveOnMerge ?? null,
      effectiveArchiveOnMerge: archive.enabled,
      archiveOnMergeSource: archive.source,
      baseBranch: config.baseBranch ?? null,
      defaultRunner: config.defaultRunner,
      systemPrompt: config.systemPrompt ?? null,
      defaultModels: modelsLocked
        ? nativeModels
        : { ...nativeModels, ...config.defaultModels },
      modelsLocked,
      maxParallel: config.maxParallel,
      memoryLimitMb: config.memoryLimitMb ?? null,
      worktreeRetention: config.worktreeRetention,
      liveTitleUpdates: config.liveTitleUpdates ?? null,
      reviewGate: config.reviewGate ?? null,
      worktreeSetup: setup.value,
      worktreeSetupIssue: setup.issue,
      worktreeTeardown: teardown.value,
      worktreeTeardownIssue: teardown.issue,
    };
  };

  return new Hono<ProjectApiEnv>()
    .get('/config', async (c) => {
      const repoRoot = c.get('project').root;
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot, home)));
    })

    .put('/config', jsonZodValidator(() => setConfigSchema, { runners: { ids: ['defaultRunner'], keys: ['defaultModels'] } }), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      if (agentModelsLocked(repoRoot, process.env, home) && parsed.data.defaultModels !== undefined) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      if ([parsed.data.worktreeSetup, parsed.data.worktreeTeardown].some((v) => v !== undefined) && !capabilities().settingsAdmin) {
        return c.json({ error: WORKTREE_COMMANDS_HOSTED_ERROR }, 409);
      }
      const refused = await writeMergedConfig(dataDir, parsed.data).catch((err: unknown) => ({ failed: err instanceof Error ? err.message : String(err) }));
      if (typeof refused === 'object') return c.json({ error: refused.failed }, 500);
      if (refused !== undefined) return c.json({ error: refused }, 409);
      if (parsed.data.archiveOnMerge !== undefined) deps.archiveOnMergeChanged?.();
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot, home)));
    });
}

export function createAgentConfigRoutes(capabilities: ServerCapabilitiesFn) {
  return new Hono<ProjectApiEnv>()
    .get('/agent-config', async (c) => {
      const editable = capabilities().settingsAdmin;
      return c.json(await listAgentConfig(c.get('project').root, process.env, editable));
    })

    .get('/agent-config/:id', async (c) => {
      const id = c.req.param('id');
      const def = findConfigFile(id);
      if (!def) return c.json({ error: 'unknown config file' }, 404);
      if (def.tracked === 'outside-repo' && !capabilities().settingsAdmin) {
        const error = `this file lives in your home directory and is not served on a remote cockpit — run \`${productIdentity().command} remote-settings enable\` on the host to allow it`;
        return c.json({ error }, 409);
      }
      const read = await readConfigFile(id, c.get('project').root);
      if (read === null) return c.json({ error: 'unknown config file' }, 404);
      if ('error' in read) return c.json({ error: read.error }, 500);
      return c.json(read);
    })

    .put('/agent-config/:id', jsonZodValidator(setAgentConfigSchema), async (c) => {
      if (!capabilities().settingsAdmin) {
        return c.json(
          {
            error:
              `editing agent config is disabled on this remote cockpit — run \`${productIdentity().command} remote-settings enable\` on the host to allow it`,
          },
          409,
        );
      }
      const parsed = { data: c.req.valid('json') };
      const out = await writeConfigFile(
        c.req.param('id'),
        parsed.data.content,
        parsed.data.version,
        c.get('project').root,
      );
      if (out === null) return c.json({ error: 'unknown config file' }, 404);
      if (!out.ok) return c.json({ error: out.error }, out.status);
      return c.json(out.read);
    });
}

export interface AgentWebhooksRouteDeps {
  home: Home;
  taskWebhooks: TaskWebhooks;
  taskWebhookFetch?: typeof fetch | undefined;
}

export function createAgentWebhooksRoutes(deps: AgentWebhooksRouteDeps) {
  const { home, taskWebhooks, taskWebhookFetch } = deps;
  return new Hono<ProjectApiEnv>()
    .get('/agent-webhooks', async (c) => {
      const project = c.get('project');
      const body: AgentWebhooksResponse = { webhooks: agentWebhooks(await registryEntry(project.id, project.root, home).catch(() => undefined)) };
      return c.json(body);
    })

    .post('/agent-webhooks/:webhook', paramZodValidator(agentWebhookParamsSchema.pick({ webhook: true })), jsonZodValidator(sendAgentReportInputSchema), async (c) => {
      const project = c.get('project');
      const { webhook: ref } = c.req.valid('param');
      const entry = await registryEntry(project.id, project.root, home).catch(() => undefined);
      const webhook = agentWebhook(entry, ref);
      if (!entry || !webhook) return c.json({ error: `no webhook named "${ref}" is open to agents in this project — run \`${productIdentity().command} webhook list\`` }, 404);
      const outcome = await sendAgentReport({
        projectId: entry.id,
        webhook,
        input: c.req.valid('json'),
        store: project.store,
        origin: taskWebhooks.currentOrigin(),
        fetch: taskWebhookFetch,
      });
      const body: SendAgentReportResponse = { ...outcome, webhook: { id: webhook.id, name: webhook.name } };
      return c.json(body);
    });
}

export function createSseRoutes() {
  return new Hono<ProjectApiEnv>()
    .get(
      '/runs/:id/events',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runEventsQuerySchema),
      async (c) => {
        const { store, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        const query = c.req.valid('query');
        if (query.cursor) {
          try {
            await validateLiveCursor(store.claims.sourceDataDir(id), id, query.cursor);
          } catch (error) {
            if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
            throw error;
          }
        }
        const lastEventId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10);
        const requestedAfter = Math.max(
          query.afterSeq ?? 0,
          Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0,
        );
        return streamSSENoBuffer(c, async (stream) => {
          const controller = new AbortController();
          const stop = () => controller.abort();
          const onRun = (write: RunWrite) => {
            if (write.run.id === id) void stream.writeSSE({ event: 'run', data: JSON.stringify(currentRecord(store, write)) });
          };
          const unsubscribe = store.lifecycle.subscribe({ 'run.created': onRun, 'run.updated': onRun });
          stream.onAbort(() => { stop(); unsubscribe(); });
          const feed = subscribeRunFeed({ store, dataDir }, {
            projectId: c.get('project').id, runId: id, afterSeq: requestedAfter,
            ...(query.cursor ? { cursor: query.cursor } : {}),
          }, {
            snapshot: async event => { await stream.writeSSE({ event: 'ui-event', data: JSON.stringify(event) }); },
            event: async event => {
              await stream.writeSSE({ id: String(event.seq), event: isV2WireEventType(event.type) ? 'ui-event' : 'run-event', data: JSON.stringify(event) });
            },
            reset: () => { stop(); void stream.close(); },
          }, controller.signal, Infinity);
          const run = store.getRun(id);
          if (run) await stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
          try {
            while (!stream.aborted && !controller.signal.aborted) {
              await stream.writeSSE({ event: 'ping', data: '' });
              await stream.sleep(15_000);
            }
          } finally {
            stop();
            unsubscribe();
            await feed;
          }
        });
      },
    )

    .get('/events', (c) => {
      const { store } = c.get('project');
      return streamSSENoBuffer(c, async (stream) => {
        const onRun = (write: RunWrite) => void stream.writeSSE({ event: 'run', data: JSON.stringify(currentRecord(store, write)) });
        const onDeleted = ({ runId: id }: { runId: string }) =>
          void stream.writeSSE({
            event: 'run-deleted',
            data: JSON.stringify({ id }),
          });
        const offUsage = onUsage((usage) => {
          const owned: typeof usage = {};
          for (const [runId, sample] of Object.entries(usage)) {
            if (store.getRun(runId)) owned[runId] = sample;
          }
          void stream.writeSSE({ event: 'usage', data: JSON.stringify(owned) });
        });
        const unsubscribe = store.lifecycle.subscribe({ 'run.created': onRun, 'run.updated': onRun, 'run.deleted': onDeleted });
        stream.onAbort(() => {
          unsubscribe();
          offUsage();
        });
        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });
}
