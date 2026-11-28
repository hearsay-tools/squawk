import type { ActivityProject, ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'
import { rungNeedsYou, type AttentionTone } from '@/lib/attention'

import { nameOf, type PeerWait, type RunEntry } from './activity-model'
import { isLiveStatus } from './now-box'

/**
 * Shared supervision decision record and two-tier partitioning for Live Activity
 * (hearsay-tools/squawk#4376):
 *  - Tier 1 (Attention): human-blocking states (`Needs answer`, `Needs permission`,
 *    `Needs review`, `Failed`, and turn-end/budget `Needs you`) with unwrapped preview,
 *    project identity, age, and triage action.
 *  - Tier 2 (Working & active): compact live rows (`running`, non-human `waiting`,
 *    `queued`, and retained terminal roots with live workers).
 */

export type DecisionKind = 'permission' | 'answer' | 'respond' | 'review' | 'failed'

export interface DecisionRecord {
  runId: string
  projectId: string
  projectName: string
  task: ActivityRun
  kind: DecisionKind
  stateLabel: string
  tone: AttentionTone
  /** Unwrapped blocking reason: full question, review summary, error line, or wait reason. */
  blockingReason: string
  /** Timestamp the blocking state started, for live waiting age. */
  ageSince?: string | undefined
  actionLabel: 'Answer' | 'Respond' | 'Review' | 'Inspect' | 'Open task'
}

export type WorkingTier = 'running' | 'waiting' | 'queued' | 'retained'

export interface WorkingRecord {
  runId: string
  projectId: string
  projectName: string
  task: ActivityRun
  tier: WorkingTier
}

export interface ActivityPartition {
  attention: DecisionRecord[]
  working: WorkingRecord[]
}

export interface ProjectGroup<T> {
  projectId: string
  projectName: string
  items: T[]
}

const DECISION_PRIORITY: Record<DecisionKind, number> = {
  permission: 0,
  answer: 1,
  respond: 2,
  review: 3,
  failed: 4,
}

const WORKING_PRIORITY: Record<WorkingTier, number> = {
  running: 0,
  waiting: 1,
  queued: 2,
  retained: 3,
}

const QUEUED_RUNGS = new Set(['queued', 'waiting-for-capacity'])

/** True when a root task belongs in the top Attention queue rather than the compact Working list. */
export function isAttentionTask(task: ActivityRun): boolean {
  if (task.status === 'review' || task.status === 'failed') return true
  if (task.rung === 'failed') return true
  return isLiveStatus(task.status) && rungNeedsYou(task.rung)
}

function humanDecision(
  base: Pick<DecisionRecord, 'runId' | 'projectId' | 'projectName' | 'task'>,
): DecisionRecord {
  const { task } = base
  const humanWait = task.wait?.kind === 'human' ? task.wait : undefined
  if (humanWait?.detail.reason === 'question') {
    return {
      ...base,
      kind: 'answer',
      stateLabel: 'Needs answer',
      tone: 'pending',
      blockingReason: humanWait.detail.question ?? 'The agent asked a question and is waiting for your answer.',
      ageSince: humanWait.since,
      actionLabel: 'Answer',
    }
  }
  if (humanWait?.detail.reason === 'budget') {
    const queued = humanWait.detail.queuedMessages
    return {
      ...base,
      kind: 'respond',
      stateLabel: 'Needs you',
      tone: 'pending',
      blockingReason: queued
        ? `Automatic wakes used up · ${queued} queued ${queued === 1 ? 'message' : 'messages'} waiting.`
        : 'Automatic wakes used up.',
      ageSince: humanWait.since,
      actionLabel: 'Respond',
    }
  }
  return {
    ...base,
    kind: 'respond',
    stateLabel: 'Needs you',
    tone: 'pending',
    blockingReason: 'Your turn to reply or finish the task.',
    ageSince: humanWait?.since ?? task.startedAt ?? task.createdAt,
    actionLabel: 'Respond',
  }
}

function decisionFor(project: Pick<ActivityProject, 'projectId' | 'name'>, task: ActivityRun): DecisionRecord {
  const base = { runId: task.runId, projectId: project.projectId, projectName: project.name, task }
  const settledAge = task.finishedAt ?? task.startedAt ?? task.createdAt
  if (task.rung === 'needs-permission') {
    const waitSince = task.wait && 'since' in task.wait ? task.wait.since : undefined
    return {
      ...base,
      kind: 'permission',
      stateLabel: 'Needs permission',
      tone: 'pending',
      blockingReason: 'Waiting for permission approval before continuing.',
      ageSince: waitSince ?? task.startedAt ?? task.createdAt,
      actionLabel: 'Open task',
    }
  }
  if (task.status === 'review' || task.rung === 'needs-review') {
    return {
      ...base,
      kind: 'review',
      stateLabel: 'Needs review',
      tone: 'info',
      blockingReason: 'Changes are ready for review before anything lands.',
      ageSince: settledAge,
      actionLabel: 'Review',
    }
  }
  if (task.status === 'failed' || task.rung === 'failed') {
    return {
      ...base,
      kind: 'failed',
      stateLabel: 'Failed',
      tone: 'danger',
      blockingReason: task.error ?? 'Task stopped with an error.',
      ageSince: settledAge,
      actionLabel: 'Inspect',
    }
  }
  return humanDecision(base)
}

function workingTierOf(task: ActivityRun): WorkingTier {
  if (!isLiveStatus(task.status)) return 'retained'
  if (task.rung === 'running') return 'running'
  if (QUEUED_RUNGS.has(task.rung)) return 'queued'
  return 'waiting'
}

const parsedTime = (iso: string | undefined): number => {
  if (!iso) return Number.POSITIVE_INFINITY
  const value = Date.parse(iso)
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value
}

/** Partition every readable project's tasks into priority-ordered Attention and compact Working lists. */
export function partitionActivity(projects: readonly ActivityProject[]): ActivityPartition {
  const attention: DecisionRecord[] = []
  const working: WorkingRecord[] = []
  for (const project of projects) {
    for (const task of project.tasks) {
      if (isAttentionTask(task)) {
        attention.push(decisionFor(project, task))
      } else {
        working.push({
          runId: task.runId,
          projectId: project.projectId,
          projectName: project.name,
          task,
          tier: workingTierOf(task),
        })
      }
    }
  }
  attention.sort((a, b) =>
    DECISION_PRIORITY[a.kind] - DECISION_PRIORITY[b.kind]
    || parsedTime(a.ageSince) - parsedTime(b.ageSince)
    || a.runId.localeCompare(b.runId),
  )
  working.sort((a, b) => WORKING_PRIORITY[a.tier] - WORKING_PRIORITY[b.tier])
  return { attention, working }
}

/** Group Attention or Working records by project, preserving the caller's project order. */
export function groupByProject<T extends { projectId: string; projectName: string }>(
  items: readonly T[],
  projectOrder: readonly string[],
): ProjectGroup<T>[] {
  const buckets = new Map<string, ProjectGroup<T>>()
  for (const item of items) {
    const existing = buckets.get(item.projectId)
    if (existing) existing.items.push(item)
    else buckets.set(item.projectId, { projectId: item.projectId, projectName: item.projectName, items: [item] })
  }
  const rank = new Map(projectOrder.map((id, index) => [id, index]))
  return [...buckets.values()].sort((a, b) => {
    const rankA = rank.get(a.projectId) ?? Number.MAX_SAFE_INTEGER
    const rankB = rank.get(b.projectId) ?? Number.MAX_SAFE_INTEGER
    return rankA - rankB || a.projectName.localeCompare(b.projectName)
  })
}

/** Short peer-impact summary for an Attention card: which tasks are waiting on this task. */
export function peerUnblocksText(
  runId: string,
  requests: readonly ActivityRequest[],
  waits: readonly PeerWait[],
  index: ReadonlyMap<string, RunEntry>,
): string | undefined {
  const blocked = new Map<string, string>()
  for (const request of requests) {
    if (request.relationship === 'peer' && request.recipientRunId === runId) {
      blocked.set(request.senderRunId, nameOf(index, request.senderRunId, request.senderTitle))
    }
  }
  for (const wait of waits) {
    if (wait.peerRunId === runId) {
      blocked.set(wait.waiterRunId, nameOf(index, wait.waiterRunId))
    }
  }
  const names = [...blocked.values()]
  if (names.length === 0) return undefined
  if (names.length === 1) return `Unblocks ${names[0]}`
  if (names.length === 2) return `Unblocks ${names[0]} + ${names[1]}`
  return `Unblocks ${names[0]} + ${names.length - 1} more`
}

/** Polite announcement when new Attention items arrive after the initial mount, without shifting focus. */
export function newAttentionAnnouncement(
  previousIds: ReadonlySet<string> | undefined,
  next: readonly DecisionRecord[],
): string | undefined {
  if (previousIds === undefined) return undefined
  const added = next.filter((item) => !previousIds.has(item.runId))
  if (added.length === 0) return undefined
  if (added.length === 1) return `New item needs your decision: ${added[0]!.task.title}`
  return `${added.length} new items need your decision`
}
