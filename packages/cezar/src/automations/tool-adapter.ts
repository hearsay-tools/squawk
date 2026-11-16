import { automationToolGithub } from './tool-github.ts';
import { withAutomationToolDeadline } from './tool-timeout.ts';
import { automationToolRequestSchema, type AutomationToolAnswer, type AutomationToolRequest } from '@open-mercato/cezar-contract/automation-tool';
import { nextOccurrence } from '@open-mercato/cezar-contract/automation-schedule';
import { ProjectAutomationScheduler } from './scheduler.ts';
import type { GithubRepository } from './github-repository.ts';
import type { GithubPoller } from './github-poller.ts';
import { writableAutomationTask } from '@open-mercato/cezar-contract/automations';
import { automationCreateSchema, automationUpdateSchema } from '@open-mercato/cezar-contract/automation-requests';
import { isValidTimeZone } from '@open-mercato/cezar-contract/zoned-time';
import { onceInstant, unknownTimeZoneMessage } from '@open-mercato/cezar-contract/automation-schedule';
import {
  parseDurationMinutes,
  resolveDelay,
  SCHEDULED_TASK_LIMITS,
  utcMinute,
  wallTimeAtOrAfter,
  SCHEDULED_TASK_NOTE,
  type ScheduleTaskAnswer,
  type ScheduleTaskRequest,
  type ScheduledTask,
  type ScheduledTaskRefusalCode,
  type ScheduledTasksAnswer,
  type ScheduledTasksRequest,
} from '@open-mercato/cezar-contract/scheduled-tasks';
import type { AutomationToolService } from '../workflows/run/types.ts';
import { projectPaths } from '../project-paths.ts';
import { withProjectAdmission } from '../server/cockpit-ownership.ts';
import { onceStatus, type AutomationService, type AutomationServiceProject } from './service.ts';
import { isGithubAutomation, isScheduleAutomation, isOnceSchedule, type AutomationDefinition, type GithubAutomationDefinition } from './types.ts';

/**
 * hearsay-tools/cezarion#1465: `cezar_schedule_task` and `cezar_scheduled_tasks` over the same
 * service the HTTP routes call, bound to one project. The agent sees one-time schedules only: a
 * repeating automation's id answers `not_found`, so these tools never change one. The agent gives
 * and reads times in UTC, as in every other Squawk tool; the schedule is stored as a wall time in
 * the cockpit's zone (or the zone it already has), so the cockpit shows it in local time.
 */
type Refusal = { ok: false; code: ScheduledTaskRefusalCode; message: string };
/** Stored shapes pass unknown keys through, so `'ok' in value` does not narrow them. */
const isRefusal = (value: object): value is Refusal => (value as Partial<Refusal>).ok === false;
const refuse = (code: ScheduledTaskRefusalCode, message: string): Refusal => ({ ok: false, code, message });
const NOT_FOUND = refuse('not_found', 'No one-time schedule has this id in this project. List them with action "list".');
const fromStatus = (failure: { status: 400 | 404 | 409; error: string }): Refusal =>
  refuse(failure.status === 400 ? 'invalid_request' : failure.status === 404 ? 'not_found' : 'conflict', failure.error);

/** The stored `at` a request names: its UTC `at` or its `delay` from now, as a wall time in the zone. */
function wallTime(request: { at?: string | undefined; delay?: string | undefined }, zone: string, now: number): string | undefined {
  if (request.at) return wallTimeAtOrAfter(Date.parse(request.at), zone);
  return request.delay ? resolveDelay(request.delay, now, zone) : undefined;
}

/** The task settings a create or an update names; an empty one leaves the stored setting. */
function taskSettings({ workflow, runner, model, effort }: { workflow?: string | undefined; runner?: string | undefined; model?: string | undefined; effort?: string | undefined }) {
  return { ...(workflow ? { workflow } : {}), ...(runner ? { runner } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function createAutomationToolService(
  service: AutomationService,
  project: AutomationServiceProject,
  deps: { timeZone: () => string; now?: () => number; github?: () => Promise<(GithubRepository & { poller: GithubPoller }) | undefined> },
): Required<AutomationToolService> {
  const now = deps.now ?? Date.now;
  // A capability's lifetime signal is unique to one session, including Continue and recovery.
  // Weak keys release preview evidence when that session is gone; no project-wide permission.
  const previews = new WeakMap<AbortSignal, Map<string, number>>();
  const repeatingView = (automation: AutomationDefinition): Extract<AutomationToolAnswer, { ok: true }> => {
    const address = project.manager.cockpitAddress?.();
    const next = isScheduleAutomation(automation)
      ? automation.enabled ? project.automationStore.state(automation.id)?.nextRunAt : nextOccurrence(automation.schedule, now(), deps.timeZone())
      : null;
    return { ok: true, automation,
      ...(address ? { url: `${address.origin}/p/${address.projectId}/automations/${automation.id}` } : {}),
      ...(next !== null && next !== undefined ? { next_run_at: new Date(next).toISOString() } : {}),
    };
  };

  async function automation(request: AutomationToolRequest, signal: AbortSignal, operationSignal = signal): Promise<AutomationToolAnswer> {
    const parsed = automationToolRequestSchema.safeParse(request);
    if (!parsed.success) return refuse('invalid_request', parsed.error.issues[0]?.message ?? 'invalid automation');
    request = parsed.data;
    if (operationSignal.aborted) return refuse('unavailable', 'The calling session is closed.');
    if (request.action === 'create') {
      const body = { ...request.definition, task: { worktree: true, autonomous: true, ...request.definition.task }, enable: false };
      const result = await service.create(project, body);
      return result.ok ? repeatingView(result.automation) : fromStatus(result);
    }
    // Refresh before checking preview revisions: other sessions and the CLI can edit definitions.
    project.automationStore.reload();
    const found = service.get(project, request.id);
    if (!found.ok) return fromStatus(found);
    const stored = found.body.automation;
    if (isOnceSchedule(stored)) return refuse('not_found', 'Use cezar_scheduled_tasks for a one-time schedule.');
    if (request.action === 'show') return repeatingView(stored);
    if (request.action === 'enable') {
      if (request.explicit !== true) return { ok: false, code: 'explicit_required', message: 'Pass explicit: true only when the user explicitly asked to enable this automation.' };
      if (isGithubAutomation(stored) && previews.get(signal)?.get(stored.id) !== stored.revision) {
        return { ok: false, code: 'preview_required', message: 'Preview this GitHub poll in this session before enabling it. Preview again after any edit.' };
      }
      const result = await service.enable(project, stored.id, stored.revision);
      return result.ok ? repeatingView(result.automation) : fromStatus(result);
    }
    if (!isGithubAutomation(stored)) return refuse('invalid_request', 'A schedule has nothing to preview; report next_run_at.');
    return preview(stored, signal, operationSignal);
  }

  /** Preview owns its evidence lifecycle, including failure, revision change and session close. */
  async function preview(stored: GithubAutomationDefinition, signal: AbortSignal, operationSignal: AbortSignal): Promise<AutomationToolAnswer> {
    // A failed repeat preview cannot leave an earlier successful receipt usable.
    previews.get(signal)?.delete(stored.id);
    try {
      const github = await (deps.github ? deps.github() : automationToolGithub(project.root));
      operationSignal.throwIfAborted();
      const scheduler = new ProjectAutomationScheduler({ projectId: project.id, store: project.automationStore, timeZone: deps.timeZone(), ...(github ? { github } : {}) });
      const result = await scheduler.check(stored, 'preview', operationSignal);
      operationSignal.throwIfAborted();
      project.automationStore.reload();
      if (project.automationStore.get(stored.id)?.revision !== stored.revision) return refuse('conflict', 'The automation changed during preview; preview it again.');
      const sessionPreviews = previews.get(signal) ?? new Map<string, number>();
      sessionPreviews.set(stored.id, stored.revision);
      previews.set(signal, sessionPreviews);
      return { ...repeatingView(stored), preview: { matches: result.candidates.length, truncated: result.truncated } };
    } catch (error) {
      return refuse('unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  const view = (definition: AutomationDefinition): ScheduledTask => {
    const schedule = definition.schedule!;
    const address = project.manager.cockpitAddress?.();
    const runId = definition.archived?.runId;
    return {
      id: definition.id,
      name: definition.name,
      status: onceStatus(definition, project.automationStore.state(definition.id)) ?? 'paused',
      due_at: utcMinute(onceInstant(schedule) ?? 0),
      ...(schedule.latestStartMinutes !== undefined ? { latest_start_minutes: schedule.latestStartMinutes } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(address ? { url: `${address.origin}/p/${address.projectId}/automations/${definition.id}` } : {}),
    };
  };

  /** The schedule a request asks for, or the refusal that names why it cannot be one. */
  const scheduleOf = (request: { at?: string | undefined; delay?: string | undefined; latest_start?: string | undefined }, stored?: NonNullable<AutomationDefinition['schedule']>) => {
    const zone = stored?.timeZone ?? deps.timeZone();
    if (!isValidTimeZone(zone)) return refuse('invalid_request', unknownTimeZoneMessage(zone));
    const at = wallTime(request, zone, now()) ?? stored?.at;
    const latest = request.latest_start !== undefined ? parseDurationMinutes(request.latest_start) : stored?.latestStartMinutes;
    return { type: 'once' as const, at, timeZone: zone, ...(latest !== undefined ? { latestStartMinutes: latest } : {}) };
  };

  /** The stored one-time schedule, or `not_found` for a missing or repeating id. */
  const onceDefinition = (id: string): AutomationDefinition | Refusal => {
    const found = service.get(project, id);
    return found.ok && isOnceSchedule(found.body.automation) ? found.body.automation : NOT_FOUND;
  };

  const settled = (result: { ok: true; automation: AutomationDefinition } | { ok: false; status: 400 | 404 | 409; error: string }) =>
    result.ok ? { ok: true as const, task: view(result.automation) } : fromStatus(result);

  const tools = {
    async scheduleTask(request: ScheduleTaskRequest): Promise<ScheduleTaskAnswer> {
      const schedule = scheduleOf(request);
      if (isRefusal(schedule)) return schedule;
      const body = automationCreateSchema.safeParse({
        name: request.name,
        kind: 'schedule',
        schedule,
        // Nobody waits on a scheduled task: autonomous, as the CLI and the cockpit create it.
        task: { prompt: request.prompt, autonomous: true, ...taskSettings(request) },
        enable: request.enable === true,
      });
      if (!body.success) return refuse('invalid_request', body.error.issues[0]?.message ?? 'invalid schedule');
      const result = await service.create(project, body.data);
      return result.ok ? { ok: true, task: view(result.automation), note: SCHEDULED_TASK_NOTE } : fromStatus(result);
    },

    async scheduledTasks(request: ScheduledTasksRequest): Promise<ScheduledTasksAnswer> {
      if (request.action === 'list') {
        const listed = await service.list(project, { archived: request.archived });
        const tasks = listed.automations.filter(isOnceSchedule).map(view)
          .sort((a, b) => a.due_at.localeCompare(b.due_at));
        return { ok: true, tasks: tasks.slice(0, SCHEDULED_TASK_LIMITS.list) };
      }
      const stored = onceDefinition(request.id);
      if (isRefusal(stored)) return stored;
      switch (request.action) {
        case 'show': return { ok: true, task: view(stored) };
        case 'pause': return settled(await service.pause(project, stored.id));
        case 'enable': return settled(await service.enable(project, stored.id));
        case 'cancel': return settled(await service.cancel(project, stored.id));
        case 'update': {
          const moves = request.at !== undefined || request.delay !== undefined || request.latest_start !== undefined;
          const schedule = moves ? scheduleOf(request, stored.schedule) : stored.schedule;
          if (schedule && isRefusal(schedule)) return schedule;
          const body = automationUpdateSchema.safeParse({
            name: request.name ?? stored.name,
            ...(stored.description !== undefined ? { description: stored.description } : {}),
            enabled: stored.enabled,
            kind: stored.kind,
            schedule,
            task: { ...writableAutomationTask(stored.task), ...(request.prompt !== undefined ? { prompt: request.prompt } : {}), ...taskSettings(request) },
            expectedRevision: stored.revision,
          });
          if (!body.success) return refuse('invalid_request', body.error.issues[0]?.message ?? 'invalid schedule');
          return settled(await service.update(project, stored.id, body.data));
        }
      }
    },
  };
  // Session tools do not pass through the HTTP route admission middleware.
  return {
    automation: async (request, signal) => {
      const admitted = (operationSignal: AbortSignal) => withProjectAdmission(projectPaths(project.root).write,
        () => automation(request, signal, operationSignal), error => refuse('conflict', error.message));
      try {
        return await (request.action === 'preview' ? withAutomationToolDeadline(signal, admitted) : admitted(signal));
      } catch (error) {
        return refuse('unavailable', error instanceof Error ? error.message : String(error));
      }
    },
    scheduleTask: request => withProjectAdmission(projectPaths(project.root).write,
      () => tools.scheduleTask(request), error => refuse('conflict', error.message)),
    scheduledTasks: request => withProjectAdmission(projectPaths(project.root).write,
      () => tools.scheduledTasks(request), error => refuse('conflict', error.message)),
  };
}
