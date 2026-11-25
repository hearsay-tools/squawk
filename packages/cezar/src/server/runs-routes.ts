import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import type { ApiRun, ArchivedRunsResponse, RunSummary } from '@open-mercato/cezar-contract';
import { providerForActiveRun } from '@open-mercato/cezar-contract/active-provider';
import { artifactParamsSchema, fileLinkQuerySchema } from '@open-mercato/cezar-contract/artifacts';
import { runRelationshipsSchema, workerDestroyRequestSchema, workerEmptyRequestSchema } from '@open-mercato/cezar-contract/delegation';
import { runHistoryQuerySchema, runIdParamSchema } from '@open-mercato/cezar-contract/events';
import { imageMimeType } from '@open-mercato/cezar-contract/image-path';
import { permissionDecisionSchema } from '@open-mercato/cezar-contract/permissions';
import { worktreeFilesQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { gitCommitSchema } from '@open-mercato/cezar-contract/repo-requests';
import { ARCHIVED_RUNS_PAGE_DEFAULT } from '@open-mercato/cezar-contract/run-limits';
import { latestSession } from '@open-mercato/cezar-contract/run-predicates';
import { archiveSchema, continueSchema, openInSchema, queuedMessagePatchSchema } from '@open-mercato/cezar-contract/run-requests';
import { removedRunnerMessage } from '@open-mercato/cezar-contract/runner';
import {
  archiveFinishedRequestSchema,
  archivedRunsQuerySchema,
  attachmentFileParamSchema,
  createRunInputSchema,
  markAllReadRequestSchema,
  messageInputSchema as messageSchema,
  notifyRunInputSchema,
  patchRunInputSchema as patchRunSchema,
  pinRunInputSchema,
  runSummariesQuerySchema,
} from '@open-mercato/cezar-contract/runs';
import { artifactPreview, loadFileLink, rasterMime } from '../artifacts/resolve.ts';
import { listArtifacts, readArtifact, readArtifactMetadata } from '../artifacts/store.ts';
import { loadConfig } from '../config.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { profileEnv } from '../core/agent-profiles.ts';
import type { ContentBlock } from '../core/agent-runner.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { resumeCommand } from '../core/runner-cli.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { registeredRunnerId, resolveRunnerId, runnerDefinition } from '../core/runner-registry.ts';
import { shellQuote, withEnvPrefix } from '../core/shell-env.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { delegationFailure } from '../delegation/routes.ts';
import { DelegationService, type WorkerCleanupFactory } from '../delegation/service.ts';
import { worktreeDiff } from '../git-worktree.ts';
import { releaseThenRemoveWorktree } from '../git-worktree-release.ts';
import { readHandoff, renderHandoffRecords } from '../handoff.ts';
import type { Home } from '../home/home.ts';
import type { PreviewHost } from '../preview/host.ts';
import { fallbackProjectWriteError } from '../project-paths.ts';
import { deriveRunContextEvents, HistoryCursorError, readRunHistoryPage } from '../runs/event-history.ts';
import { ownPullRequestNumbers } from '../runs/pull-requests.ts';
import { ARCHIVED_WINDOW } from '../runs/run-index.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TaskWebhooks } from '../runs/webhook.ts';
import { resolveAttachmentPathAsync } from '../workflows/attachment-path.ts';
import { toPastedContent, type PastedContent } from '../workflows/pasted-content.ts';
import { isUntouchedCancelledRun } from '../workflows/run/run-guards.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../workspace/agent-accounts.ts';
import { taskWebhooks as taskWebhookList } from '../workspace/webhooks.ts';
import { FILE_FORMATS, negotiate } from './accept-negotiation.ts';
import { forgeWebRoot, resolveForgeRoot, type ForgeFactory } from './forge/index.ts';
import { getRepoInfo } from './git.ts';
import { collectChanges, collectCommitChanges, collectRunCommits, commitAll, pushCurrentBranch, readWorktreePath } from './git-changes.ts';
import { agentCliRunner } from './open-in-app.ts';
import { freshCliHandoff, openRunApp, openRunCli, openRunDefaultApp } from './open-in-targets.ts';
import { adoptFallbackControl, protectFallbackRun, runArtifactDirectory } from './project-run-files.ts';
import { continueRunProviders } from './provider-action-gate.ts';
import { preparePublishCheckout, runCheckout } from './run-checkout.ts';
import { runRelationships } from './run-relationships.ts';
import type {
  ProjectApiEnv,
  ProviderStatusBundle,
  ResolvedServerDeps,
  ResolveWorkspaceProfileFn,
  ServerCapabilitiesFn,
} from './server-types.ts';
import {
  agentProfileRefusal,
  clientRequestOf,
  launchRun,
  modelLockRefusal,
  NO_WEBHOOK_ERROR,
  notifyRefusal,
  providerGateRefusal,
  replayedRun,
  resolveStartWorkflow,
  startRunInput,
} from './start-run-options.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

const UNREADABLE_RUN_ERROR = `this run could not be read by this Squawk: its record in runs.db does not fit this version (a newer Squawk may have written it). It is left in the database untouched.`;

const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_ATTACHMENTS = 8;
const MAX_FOLDED_TASK_CHARS = 200_000;

const IMAGE_TYPES: Record<string, string> = {
  img: 'application/octet-stream',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

export function withLiveUsage(summary: RunSummary): RunSummary {
  const usage = currentUsage(summary.id);
  return usage ? { ...summary, usage } : summary;
}

function withUsage(run: RunRecord, finishBlocked?: string | null): ApiRun {
  const usage = currentUsage(run.id);
  const { sessionId, backend } = latestSession(run);
  const command = sessionId ? resumeCommand(resolveRunnerId(backend), sessionId) : null;
  return {
    ...run,
    ...(usage ? { usage } : {}),
    ...(command ? { cliResumeCommand: command } : {}),
    ...(runnerDefinition(resolveRunnerId(backend)).cli.interactive === false ? { cliHandoff: false as const } : {}),
    ...(finishBlocked !== undefined ? { finishBlocked } : {}),
  };
}

export interface RunsRouteDeps {
  home: Home;
  forgeFactory?: ForgeFactory | undefined;
  delegation?: DelegationController | undefined;
  workerCleanup?: WorkerCleanupFactory | undefined;
  previewHost?: PreviewHost | undefined;
  capabilities: ServerCapabilitiesFn;
  modelCatalog: RunnerModelCatalog;
  providerStatus: ProviderStatusBundle['providerStatus'];
  providerActionError: ProviderStatusBundle['providerActionError'];
  resolveWorkspaceProfile: ResolveWorkspaceProfileFn;
  projectRegistryEntry: WorkspaceProjects['registryEntry'];
  taskWebhooks: TaskWebhooks;
  openTerminal: ResolvedServerDeps['openTerminal'];
  openFile: ResolvedServerDeps['openFile'];
  openApp: ResolvedServerDeps['openApp'];
}

export function createRunsRoutes(deps: RunsRouteDeps) {
  const {
    home,
    forgeFactory,
    previewHost,
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
  } = deps;

  const openHandoffCheckout = (c: Context<ProjectApiEnv>, suffix = '') => {
    const checkout = runCheckout(c.get('project'), c.req.param('id')!, 'open');
    if ('status' in checkout) return checkout;
    return !capabilities().localHandoff
      ? { status: 409 as const, body: { error: `local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)${suffix}` } }
      : checkout;
  };

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

  const handoffFallbackCommand = (cwd: string, command: string, env: Record<string, string>): string | null => {
    const prefixed = withEnvPrefix(command, env, process.platform);
    return prefixed === null ? null : `cd ${shellQuote(cwd)} && ${prefixed}`;
  };

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
    return c.req.path.endsWith('/worker-destroy')
      ? c.json({ code: 'incompatible_state' as const, error: refusal }, 409)
      : c.json({ error: refusal }, 409);
  };

  const delegationService = deps.delegation?.service ?? new DelegationService(deps.workerCleanup);
  delegationService.setDiscovery({ models: modelCatalog, providers: providerStatus });

  return new Hono<ProjectApiEnv>()
    .use('/runs/:id', adoptFallbackControl, requireRunControl)
    .use('/runs/:id/*', adoptFallbackControl, requireRunControl)
    .get('/runs', (c) => c.json(c.get('project').store.queries.listAllRunsForLegacyRoute().map(run => withUsage(run))))
    .get('/run-summaries', queryZodValidator(runSummariesQuerySchema), (c) => {
      const archivedWindow = c.req.valid('query').archived === 'recent' ? ARCHIVED_WINDOW : undefined;
      return c.json(c.get('project').store.queries.listRunSummaries({ archivedWindow }).runs.map(withLiveUsage));
    })
    .get('/run-summaries/archived', queryZodValidator(archivedRunsQuerySchema), (c) => {
      const { before, limit, q } = c.req.valid('query');
      const project = c.get('project');
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
    .post('/runs/archive-finished', jsonZodValidator(archiveFinishedRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json(c.get('project').store.archive.archiveFinished(c.req.valid('json').scope, c.req.valid('json').automation)))
    .post('/runs/read-all', jsonZodValidator(markAllReadRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json({ read: c.get('project').store.readFlags.markAllRead(c.req.valid('json').automation) }))
    .post('/runs/:id/archive', jsonZodValidator(archiveSchema, { absent: ({}) }), async (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      const parsed = { data: c.req.valid('json') };
      const run = store.archive.setArchived(id, parsed.data.archived !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
    .post('/runs/:id/pin', paramZodValidator(runIdParamSchema), jsonZodValidator(pinRunInputSchema, { absent: {}, malformed: null }), (c) => {
      const { store } = c.get('project');
      const run = store.readFlags.setPinned(c.req.valid('param').id, c.req.valid('json').pinned !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
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
    .delete('/runs/:id/auto-resume', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      manager.cancelAutoResume(id);
      return c.json({ cancelled: true as const });
    })
    .post('/runs/:id/read', (c) => {
      const run = c.get('project').store.readFlags.setRead(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })
    .post('/runs/:id/unread', (c) => {
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
      const locked = modelLockRefusal(repoRoot, body, home);
      if (locked) return c.json({ error: locked.error }, locked.status);
      const resolved = await resolveStartWorkflow(repoRoot, body);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const { workflow } = resolved;
      const runner = body.runner === undefined ? (await loadConfig(repoRoot, home)).defaultRunner : registeredRunnerId(body.runner);
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

    .patch('/runs/:id', jsonZodValidator(patchRunSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
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
        store.updateRun(id, {
          title: parsed.data.title,
          titleSummary: parsed.data.title,
          titleOrigin: 'user',
        });
      }
      const { title: _title, task: _task, ...options } = parsed.data;
      if (Object.values(options).some(value => value !== undefined)) store.updateRun(id, options);
      return c.json(store.getRun(id));
    })

    .post('/runs/:id/cancel', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const cancelled = manager.cancel(id) || c.get('stoppedOnAdoption') === true;
      return c.json({ cancelled });
    })

    .post('/runs/:id/permissions', paramZodValidator(runIdParamSchema), jsonZodValidator(permissionDecisionSchema), (c) => {
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
      if (run.status !== 'queued') {
        const blocked = await providerActionError([resolveRunnerId(providerForActiveRun(run))], { repoRoot: c.get('project').root, run, live: true });
        if (blocked) return c.json({ error: blocked }, 409);
      }
      const content: PastedContent[] = [
        ...parsed.data.images.map(toPastedContent),
        ...(parsed.data.text.trim() ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock] : []),
      ];
      if (manager.sendMessage(id, content)) return c.json({ delivered: true });

      const currentRun = store.getRun(id);
      const stack = currentRun?.queuedMessages ?? [];
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

    .post('/runs/:id/finish', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const finished = manager.finish(id);
      if (!finished) return c.json({ error: manager.finishBlockedReason(id) ?? 'no open session' }, 409);
      return c.json({ finished: true });
    })

    .post('/runs/:id/continue', jsonZodValidator(continueSchema, { absent: ({}), runners: { ids: ['runner'] } }), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const body = c.req.valid('json');
      if (
        agentModelsLocked(repoRoot, process.env, home) &&
        (body.model?.trim() || body.effort?.trim())
      ) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      if (run.removedRunner !== undefined && body.runner === undefined) {
        return c.json({ error: removedRunnerMessage(run.removedRunner) }, 409);
      }
      const untouched = isUntouchedCancelledRun(run);
      const { original: originalProvider, target: provider, required } = await continueRunProviders(
        run, body.runner, untouched, async () => (await loadConfig(repoRoot, home)).defaultRunner,
      );
      const blocked = await providerActionError(required, { repoRoot, run, untouched, runners: { original: originalProvider, target: provider } });
      if (blocked) return c.json({ error: blocked }, 409);
      const result = manager.continueRun(id, {
        text: body.text,
        images: body.images?.map(toPastedContent),
        runner: untouched || body.runner !== undefined ? provider : undefined,
        ...(untouched ? { originalRunner: originalProvider } : {}),
        model: body.model,
        effort: body.effort,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ continued: true });
    })

    .post('/runs/:id/open-in-cli', async (c) => {
      const project = c.get('project');
      const checkout = openHandoffCheckout(c, '; resume the session from a machine that has the checkout');
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      if (checkout.run.removedRunner !== undefined) return c.json({ error: removedRunnerMessage(checkout.run.removedRunner) }, 409);
      const { sessionId, backend: savedBackend, profileId } = latestSession(checkout.run), backend = resolveRunnerId(savedBackend);
      if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
      if (runnerDefinition(backend).cli.interactive === false) return c.json({ error: 'this runner has no interactive CLI' }, 409);
      const resume = checkout.resumeAllowed ? resumeCommand(backend, sessionId) : undefined;
      if (resume === null) return c.json({ error: 'the recorded session id has an unexpected shape' }, 409);
      const blocked = await providerActionError([backend], { repoRoot: project.root, picks: { [backend]: resume ? profileId ?? DEFAULT_AGENT_ACCOUNT_ID : undefined } });
      if (blocked) return c.json({ error: blocked }, 409);
      const cwd = checkout.directory();
      const refusal = fallbackProjectWriteError(cwd);
      if (refusal) return c.json({ error: refusal }, 409);
      const account = resume
        ? { command: resume, ...await handoffEnv(backend, profileId) }
        : await freshCliHandoff(backend, project.root, home);
      if ('error' in account) return c.json({ error: account.error }, 409);
      const { command } = account;
      const fallback = handoffFallbackCommand(cwd, command, account.env);
      if (fallback === null) {
        return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
      }
      const opened = await openTerminal(cwd, command, account.env);
      if (!opened) {
        return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
      }
      return c.json({ opened: true, command });
    })

    .post('/runs/:id/open-in', jsonZodValidator(openInSchema), async (c) => {
      const project = c.get('project');
      const checkout = openHandoffCheckout(c);
      if ('status' in checkout) return c.json(checkout.body, checkout.status);
      const { target, path: relPath } = c.req.valid('json');
      const dir = checkout.directory();

      if (target === 'default') {
        const worktree = checkout.defaultWorktree();
        if (typeof worktree !== 'string') return c.json(worktree.body, worktree.status);
        return openRunDefaultApp(c, worktree, relPath, openFile);
      }
      const cliRunner = agentCliRunner(target);
      if (cliRunner) {
        return openRunCli(c, checkout.run, cliRunner, dir, project.root, {
          home,
          providerActionError, resumeCommand, handoffEnv, handoffFallbackCommand, openTerminal,
        }, checkout);
      }
      return openRunApp(c, target, dir, openApp);
    })

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
      const type = image ?? FILE_TYPES[ext] ?? 'application/octet-stream';
      return new Response(await readFile(path), {
        headers: {
          'content-type': type,
          'cache-control': 'private, max-age=31536000, immutable',
          ...(image
            ? {}
            : {
                'x-content-type-options': 'nosniff',
                'content-disposition': `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
              }),
        },
      });
    })

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
        runStartedAt: run.startedAt,
        intentToAdd: run.worktreePath ? undefined : false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    .get('/runs/:id/commits', async (c) => {
      const checkout = runCheckout(c.get('project'), c.req.param('id'), 'read', { directory: 'working-directory' });
      if ('body' in checkout) return c.json(checkout.body, checkout.status);
      const { run, directory: workingDirectory } = checkout;
      const result = await collectRunCommits(workingDirectory, run.baseBranch ?? 'HEAD');
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ commits: result.commits });
    })

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
          type: 'dir' as const,
          path: result.path,
          entries: result.entries,
        });
      }
      if (wantsRaw) {
        const mime = imageMimeType(result.path);
        if (mime === null || result.tooLarge) {
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
      resolveForgeRoot(repoRoot, forgeFactory).branchPushed(ownPullRequestNumbers(run, repoBase));
      return c.json({
        pushed: true,
        branch: result.branch,
        remote: result.remote,
        upstreamSet: result.upstreamSet,
      });
    })

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
        const outcome = await resolveForgeRoot(repoRoot, forgeFactory).createPR({
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
        if (run.worktreePath) await releaseThenRemoveWorktree({ previewHost }, id, repoRoot, run.worktreePath, run.branch);
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
        if (run.delegation?.role !== 'worker' && run.worktreePath) await releaseThenRemoveWorktree({ previewHost }, id, repoRoot, run.worktreePath, run.branch);
        return store.retention.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'history cleanup incomplete — retry deletion' }, 409);
      } finally { release(); }
    });
}
