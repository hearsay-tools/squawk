import {
  BanIcon,
  BotIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HourglassIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PauseIcon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ActivityRun, ActivityWorker } from '@open-mercato/cezar-api-client/contract/activity'

import type { ComponentProps } from 'react'

import { StatusDot } from '@/components/status-dot'
import { attentionOfRung, type AttentionShape, type AttentionTone } from '@/lib/attention'
import { canonicalRungLabel } from '@/lib/status-semantics'
import { cn } from '@/lib/utils'

import { isLiveStatus, type NowIcon } from './now-box'

/** Readable ink for each attention tone on a card or on card-2 (packages/web/docs/card-2-contrast.md):
 *  pending reads as the amber signal word, danger as the red one and neutral as muted text.
 *  Small text on card-2 spells these classes out where the cez/card-2-contrast lint can read them
 *  (`NowBoxView`); a class read from this map is invisible to it. */
export const TONE_INK: Record<AttentionTone, string> = {
  success: 'text-semantic-green',
  pending: 'text-semantic-amber',
  danger: 'text-semantic-red',
  accent: 'text-accent-text',
  info: 'text-semantic-info',
  running: 'text-semantic-violet',
  neutral: 'text-muted-foreground',
}

/**
 * Small text in a tone's readable ink, the verb of a now box or a pill. Each tone's ink is a
 * literal branch, and the word carries its own card-2 surface (both callers sit on card-2), so
 * the cez/card-2-contrast lint checks every branch as small text on card-2 right here.
 */
export function ToneWord({ tone, className, children, ...props }: ComponentProps<'span'> & { tone: AttentionTone }) {
  return (
    <span
      {...props}
      className={cn('bg-card-2', {
        'text-semantic-green': tone === 'success',
        'text-semantic-amber': tone === 'pending',
        'text-semantic-red': tone === 'danger',
        'text-accent-text': tone === 'accent',
        'text-semantic-info': tone === 'info',
        'text-semantic-violet': tone === 'running',
        'text-muted-foreground': tone === 'neutral',
      }, className)}
    >
      {children}
    </span>
  )
}

/** A tone as a border and as a fill: the flash of a card and the tint of a settled worker row. */
export const TONE_BORDER: Record<AttentionTone, string> = {
  success: 'border-success',
  pending: 'border-pending-strong',
  danger: 'border-danger',
  accent: 'border-accent-strong',
  info: 'border-info',
  running: 'border-status-running',
  neutral: 'border-soft-foreground',
}

export const TONE_FILL: Record<AttentionTone, string> = {
  success: 'bg-success',
  pending: 'bg-pending-strong',
  danger: 'bg-danger',
  accent: 'bg-accent-strong',
  info: 'bg-info',
  running: 'bg-status-running',
  neutral: 'bg-soft-foreground',
}

export const NOW_ICON: Record<NowIcon, LucideIcon> = {
  tool: WrenchIcon,
  user: UserIcon,
  workers: BotIcon,
  reply: MessageSquareIcon,
  peer: MessagesSquareIcon,
  subagents: BotIcon,
  ci: GitPullRequestIcon,
  merge: GitMergeIcon,
  command: TerminalIcon,
  timer: ClockIcon,
  pause: PauseIcon,
  queued: HourglassIcon,
  review: EyeIcon,
  failed: CircleXIcon,
  done: CircleCheckIcon,
  cancelled: BanIcon,
}

/**
 * The status shape of a card or a worker row, from the snapshot's rung. A worker that waits on
 * its parent, and a root that waits on peers, wait outside themselves: the ring, as
 * `deriveAttention` draws them.
 */
export function shapeOf(run: Pick<ActivityRun | ActivityWorker, 'rung' | 'wait'>, role: 'root' | 'worker'): { tone: AttentionTone; shape: AttentionShape; label: string } {
  const attention = attentionOfRung(run.rung)
  const outside = run.rung === 'waiting-on-workers' && (role === 'worker' || run.wait?.kind === 'peers')
  return { tone: attention.tone, shape: outside ? 'ring' : attention.shape, label: labelOf(run, role) ?? canonicalRungLabel(run.rung, attention.label) }
}

const counted = (lead: string, n: number, noun: string) => `${lead} ${n} ${noun}${n === 1 ? '' : 's'}`

/** The snapshot is computed now from the open waits: only a wait on workers lacks `replies`, and a
 *  worker can open one only for workers it started. */
function waitsOnOwnWorkers(wait: (ActivityRun | ActivityWorker)['wait']): boolean {
  return wait?.kind === 'workers' && !wait.detail.replies && wait.detail.owed > 0
}

/**
 * The dot's accessible name for the waits whose rung label is generic. These are the canonical
 * Sentence-case labels used across the cockpit: a worker waits for its parent's reply, a root for
 * its peers, for replies, for N workers or for N subagents.
 */
function labelOf(run: Pick<ActivityRun | ActivityWorker, 'rung' | 'wait'>, role: 'root' | 'worker'): string | undefined {
  const wait = run.wait
  if (run.rung === 'waiting-on-workers') {
    if (role === 'worker' && !waitsOnOwnWorkers(wait)) return 'Waiting for parent reply'
    if (wait?.kind === 'peers' && wait.detail.peerRunIds.length > 0) return counted('Waiting for', wait.detail.peerRunIds.length, 'task')
    if (wait?.kind === 'workers' && wait.detail.replies) return 'Waiting for replies'
    if (wait?.kind === 'workers' && wait.detail.owed > 0) return counted('Waiting for', wait.detail.owed, 'worker')
  }
  if (run.rung === 'waiting-on-subagents' && wait?.kind === 'subagents' && wait.detail.running > 0) return counted('Waiting for', wait.detail.running, 'subagent')
  return undefined
}

/** The shape's motion: a running dot pulses, a waiting shape (ring or robot) breathes. A settled
 *  run is still. The stylesheet turns both off with reduced motion. */
export function shapeMotion(run: Pick<ActivityRun | ActivityWorker, 'status' | 'rung'>, shape: AttentionShape): string | undefined {
  if (!isLiveStatus(run.status)) return undefined
  if (run.rung === 'running' && shape === 'filled') return 'activity-pulse'
  return shape === 'filled' ? undefined : 'activity-breathe'
}

/** The status shape with its anchor for the lines, and its motion. */
export function RunShape({ run, role }: { run: Pick<ActivityRun | ActivityWorker, 'runId' | 'rung' | 'wait' | 'status'>; role: 'root' | 'worker' }) {
  const { tone, shape, label } = shapeOf(run, role)
  return (
    <span data-activity-anchor={run.runId} className={cn('inline-flex size-[12px] shrink-0 items-center justify-center', shapeMotion(run, shape))}>
      <StatusDot tone={tone} shape={shape} role="img" aria-label={label} />
    </span>
  )
}
