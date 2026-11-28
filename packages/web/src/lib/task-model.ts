import type {
  DiffStat,
  ProcessUsage,
  RunIndexEntry,
  RunStatePreview,
  RunSummary,
  RunnersResponse,
} from '@open-mercato/cezar-api-client'
import { isUsageLimitHold } from '@open-mercato/cezar-api-client/contract/waits'

import { runnerDisplayName } from '@/api/runners'
import { deriveAttention, needsYou, type Attention, type AttentionTone } from '@/lib/attention'
import { compactTokens } from '@/lib/format'
import type { GlobalTask } from '@/lib/global-tasks'
import { scopeTo } from '@/lib/project-router'
import { canBeUnread, isReadDoneItem, isUnread, unreadMarkerTone } from '@/lib/read-state'
import { runStatusPresentation, type StatusPresentation } from '@/lib/status-semantics'
import { isOwnedWorker, runTitle } from '@/lib/task-groups'
import {
  formatCost,
  scheduledResume,
  taskReferences,
  usageCells,
  workflowLabel,
  type TaskReference,
} from '@/lib/tasks-table'

/**
 * Unified task row model shared by Project Tasks, Global Tasks, and mobile task cards
 * (hearsay-tools/squawk#4377). Every list surface projects into this shape once so field
 * derivation, urgent 1-line previews, automation badges, runner/model metadata, and telemetry
 * summaries never drift between routes or breakpoints.
 */
export interface TaskRowModel {
  /** Stable key across single-project (`run.id`) and cross-project (`projectId/run.id`) lists. */
  key: string
  runId: string
  projectId?: string | undefined
  projectName?: string | undefined
  projectHref?: string | undefined
  tags: readonly string[]
  run: RunSummary
  href: string
  title: string
  isWorker: boolean
  unread: boolean
  readDone: boolean
  canToggleRead: boolean
  unreadTone: AttentionTone
  attention: Attention
  status: StatusPresentation
  urgent: boolean
  scheduled?: { label: string; title: string } | undefined
  pinned: boolean
  queuePosition: number | null
  /** Present ONLY for automation-launched runs (replaces repetitive "Direct task" copy). */
  automationBadge?: { id: string; label: string } | undefined
  /** Canonical Runner · Model metadata line. */
  runnerModel?: string | undefined
  /** Concise 1-line preview for urgent (`Needs you`) or failed runs. */
  statePreview?: RunStatePreview | undefined
  workflow: string
  branch?: string | undefined
  diffStat?: DiffStat | undefined
  references: readonly TaskReference[]
  repoBase?: string | undefined
  startedAt: string
  /** Short explicit label for the row's telemetry trigger button. */
  usageSummary: string
  hasUsageData: boolean
  /** Snapshot usage attached to index rows (Project Tasks reads live SSE samples on open). */
  snapshotUsage?: ProcessUsage | undefined
  /** True when the run can be archived or restored from a row action. */
  canArchive: boolean
}

const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

function clampOneLine(text: string, max = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/** Resolve a concise 1-line preview from `run.statePreview`, with safe fallback for older summaries. */
export function resolveStatePreview(run: RunSummary, attention: Attention): RunStatePreview | undefined {
  if (run.statePreview) return run.statePreview
  if (!run.archived) {
    if (run.hasPendingPermission) return { kind: 'permission', text: 'Permission requested' }
    if (attention.rung === 'needs-you') return { kind: 'ask', text: 'Waiting for your reply' }
    if (run.status === 'review') return { kind: 'review', text: 'Ready for review' }
  }
  if (run.status === 'failed' && !isUsageLimitHold(run) && run.error) {
    const text = clampOneLine(run.error)
    if (text) return { kind: 'error', text }
  }
  return undefined
}

/** Canonical `Runner · Model` string, reading display names from `useRunners()` metadata. */
export function formatRunnerModel(
  run: Pick<RunSummary, 'runner' | 'model'>,
  runners: RunnersResponse | undefined,
): string | undefined {
  const runner = run.runner ? runnerDisplayName(runners, run.runner) : undefined
  const model = run.model?.trim() || undefined
  if (runner && model) return `${runner} · ${model}`
  return runner ?? model
}

function tokenAndCostSummary(
  run: RunSummary,
  opts: { showTokens: boolean; showCost: boolean },
): string[] {
  const parts: string[] = []
  const hasTokens = opts.showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  const totalTokens = hasTokens ? (run.inputTokens ?? 0) + (run.outputTokens ?? 0) : 0
  if (totalTokens > 0) parts.push(compactTokens(totalTokens))
  const cost = opts.showCost ? formatCost(run.costUsd) : ''
  if (cost) parts.push(cost)
  return parts
}

function hasRecordedTelemetry(run: RunSummary, cpuText: string, memText: string): boolean {
  return (
    run.inputTokens !== undefined ||
    run.outputTokens !== undefined ||
    run.costUsd !== undefined ||
    Boolean(cpuText || memText || run.branch)
  )
}

/** Compact label for the explicit telemetry trigger button on a row. */
export function formatUsageSummary(
  run: RunSummary,
  sample: ProcessUsage | undefined,
  opts: { showTokens: boolean; showCost: boolean },
): { label: string; hasData: boolean } {
  const parts = tokenAndCostSummary(run, opts)
  const cells = usageCells(run, sample)
  if (parts.length < 2 && cells.cpu.kind === 'live' && cells.cpu.text) {
    parts.push(cells.cpu.text)
  } else if (parts.length === 0 && cells.mem.text) {
    parts.push(cells.mem.text)
  }
  return {
    label: parts.length > 0 ? parts.join(' · ') : 'Usage',
    hasData: parts.length > 0 || hasRecordedTelemetry(run, cells.cpu.text, cells.mem.text),
  }
}

export interface ProjectTaskModelOptions {
  run: RunSummary
  queuePosition?: number | null
  runners?: RunnersResponse | undefined
  automationName?: ((automationId: string) => string | undefined) | undefined
  repoBase?: string | undefined
  now?: number | undefined
  showTokens?: boolean
  showCost?: boolean
}

export function projectRunToTaskModel({
  run,
  queuePosition = null,
  runners,
  automationName,
  repoBase,
  now,
  showTokens = true,
  showCost = true,
}: ProjectTaskModelOptions): TaskRowModel {
  const attention = deriveAttention(run)
  const status = runStatusPresentation(run, attention)
  const scheduled = scheduledResume(run, now === undefined ? undefined : new Date(now))
  const usage = formatUsageSummary(run, run.usage, { showTokens, showCost })
  const automationId = run.automationId
  return {
    key: run.id,
    runId: run.id,
    tags: [],
    run,
    href: `/tasks/${run.id}`,
    title: runTitle(run),
    isWorker: isOwnedWorker(run),
    unread: isUnread(run),
    readDone: isReadDoneItem(run),
    canToggleRead: canBeUnread(run),
    unreadTone: unreadMarkerTone(run),
    attention,
    status,
    urgent: needsYou(run),
    scheduled,
    pinned: Boolean(run.pinned),
    queuePosition,
    automationBadge: automationId === undefined
      ? undefined
      : { id: automationId, label: automationName?.(automationId) ?? automationId },
    runnerModel: formatRunnerModel(run, runners),
    statePreview: resolveStatePreview(run, attention),
    workflow: workflowLabel(run),
    branch: run.branch,
    diffStat: run.diffStat,
    references: taskReferences(run, repoBase),
    repoBase,
    startedAt: run.startedAt ?? run.createdAt,
    usageSummary: usage.label,
    hasUsageData: usage.hasData,
    snapshotUsage: run.usage,
    canArchive: run.archived || ARCHIVABLE_STATUSES.has(run.status),
  }
}

export interface GlobalTaskModelOptions {
  task: GlobalTask
  queuePosition?: number | null
  runners?: RunnersResponse | undefined
  automationName?: ((task: GlobalTask) => string | undefined) | undefined
  now?: number | undefined
  showTokens?: boolean
  showCost?: boolean
}

function toPathString(to: ReturnType<typeof scopeTo>): string {
  return typeof to === 'string' ? to : (to.pathname ?? '')
}

export function globalTaskToTaskModel({
  task,
  queuePosition = null,
  runners,
  automationName,
  now,
  showTokens = true,
  showCost = true,
}: GlobalTaskModelOptions): TaskRowModel {
  const run: RunIndexEntry = task.run
  const base = projectRunToTaskModel({
    run,
    queuePosition,
    runners,
    automationName: automationName ? () => automationName(task) : undefined,
    repoBase: task.project?.repoUrl,
    now,
    showTokens,
    showCost,
  })
  return {
    ...base,
    key: `${run.projectId}/${run.id}`,
    projectId: run.projectId,
    projectName: task.projectName,
    projectHref: toPathString(scopeTo(run.projectId, '/')),
    tags: task.tags,
    href: toPathString(scopeTo(run.projectId, `/tasks/${run.id}`)),
    references: taskReferences(run, task.project?.repoUrl, run.projectId),
  }
}
