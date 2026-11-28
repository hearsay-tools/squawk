import { ArrowRightIcon } from 'lucide-react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'

import { cn } from '@/lib/utils'

import { counter, since } from './activity-format'
import { feedAge, type FeedEntry, type FeedTone } from './activity-feed'
import { directionOf, recipientName, replyDueText, senderName, type RunEntry } from './activity-model'
import { windowUsed } from './activity-lines'
import { EMPTY_MOTION, type MotionState } from './activity-motion'
import { TONE_FILL } from './activity-tone'

/**
 * Activity details below the live rows (hearsay-tools/squawk#4376): renders `Open requests`
 * only when at least one request is open or folding, and `Just now` only when at least one
 * recent event exists. Zero-item placeholder boxes never render; the legend lives in the header.
 */

const PANEL = 'rounded-xl border border-card-edge bg-card px-3.5 py-3 shadow-card'
const PANEL_TITLE = 'mb-2 flex gap-2 text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase'

function RequestEntry({ request, index, now, motion }: { request: ActivityRequest; index: ReadonlyMap<string, RunEntry>; now: number; motion?: 'enter' | 'fold' | undefined }) {
  const { kind, relation } = directionOf(request, index)
  const used = windowUsed(request, now)
  const tone = request.relationship === 'peer' ? 'text-message-peer-accent' : 'text-message-inbound-accent'
  return (
    <li
      data-slot={motion === 'fold' ? 'activity-request-closing' : 'activity-request'}
      data-request={request.requestId}
      aria-hidden={motion === 'fold' ? true : undefined}
      className={cn('border-t border-border py-2.5 first:border-t-0 first:pt-0', motion === 'enter' && 'activity-row-enter', motion === 'fold' && 'activity-row-fold')}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        <span className="min-w-0 truncate">{senderName(index, request)}</span>
        <ArrowRightIcon aria-label="to" className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{recipientName(index, request)}</span>
        <span className={cn('ml-auto shrink-0 text-xs font-semibold tracking-[0.05em] uppercase', tone)}>{kind}</span>
      </div>
      <p className="my-1 line-clamp-3 text-[12px] text-muted-foreground">“{request.text}”</p>
      <div className="flex gap-1.5 text-xs text-muted-foreground tabular-nums">
        <span>{relation} · open {counter(since(request.createdAt, now))}</span>
        {request.deadline ? <span className="ml-auto">{replyDueText(request.deadline, now)}</span> : null}
      </div>
      {used === undefined ? null : (
        <div aria-hidden="true" className="mt-1.5 h-[3px] overflow-hidden rounded-sm bg-border">
          <span className={cn('block h-full bg-current', tone)} style={{ width: `${Math.round(used * 100)}%` }} />
        </div>
      )}
    </li>
  )
}

const FEED_DOT: Record<FeedTone, string> = { ...TONE_FILL, peer: 'bg-message-peer-accent', family: 'bg-message-inbound-accent' }

function JustNow({ feed, now }: { feed: readonly FeedEntry[]; now: number }) {
  return (
    <section data-slot="activity-just-now" className={PANEL}>
      <h2 className={PANEL_TITLE}>Just now</h2>
      <ul data-slot="activity-feed">
        {feed.map((entry, i) => (
          <li key={entry.id} data-slot="activity-feed-entry" className={cn('grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2 py-1 text-[12px] text-muted-foreground', i === 0 && 'activity-feed-enter')}>
            <span aria-hidden="true" className={cn('size-[7px] -translate-y-px rounded-full', FEED_DOT[entry.tone])} />
            <span className="min-w-0">{entry.text}</span>
            <span data-slot="activity-feed-age" className="text-xs tabular-nums">{feedAge(now - entry.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface RailProps {
  requests: readonly ActivityRequest[]
  /** Closed requests whose entries fold out. */
  closing?: readonly ActivityRequest[]
  index: ReadonlyMap<string, RunEntry>
  now: number
  watchingSince?: string
  feed?: readonly FeedEntry[] | undefined
  motion?: MotionState
  columnGap?: number | undefined
}

export function ActivityRail({ requests, closing = [], index, now, feed = [], motion = EMPTY_MOTION, columnGap }: RailProps) {
  const showRequests = requests.length > 0 || closing.length > 0
  const showFeed = feed.length > 0
  if (!showRequests && !showFeed) return null

  return (
    <aside
      data-slot="activity-rail"
      aria-label="Activity details"
      style={columnGap === undefined ? undefined : { columnGap }}
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] content-start items-start gap-4',
        showRequests && showFeed && 'md:grid-cols-2',
      )}
    >
      {showRequests ? (
        <section data-slot="activity-open-requests" className={PANEL}>
          <h2 className={PANEL_TITLE}>Open requests <b className="text-foreground">{requests.length}</b></h2>
          <ul>
            {requests.map((request) => <RequestEntry key={request.requestId} request={request} index={index} now={now} motion={request.requestId in motion.opening ? 'enter' : undefined} />)}
            {closing.map((request) => <RequestEntry key={request.requestId} request={request} index={index} now={now} motion="fold" />)}
          </ul>
        </section>
      ) : null}
      {showFeed ? <JustNow feed={feed} now={now} /> : null}
    </aside>
  )
}
