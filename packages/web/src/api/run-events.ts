import { subscribeLive } from './live-coordinator'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { LiveRunDemand } from '@open-mercato/cezar-api-client'
import { useEffect, useRef, useState } from 'react'

import type { RunEvent } from '@open-mercato/cezar-api-client'

/**
 * Ordered run-event and ui-event subscription list. Keep both generations. Deduplicate by seq
 * above the high-water mark; live-only events consume sequence numbers, so replay gaps are
 * normal. Snapshot frames restore open items below the mark and replace an equal seq.
 */

/** Both wire names. Exported so tests and future consumers subscribe to exactly this set. */
export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

/**
 * Parse one SSE frame into a `RunEvent`, or null for anything malformed. Null rather than a
 * throw, as everywhere on the stream boundary: one bad frame costs one frame, not the socket.
 * `seq` must be a number — it is the dedup axis, and a line without one cannot be ordered.
 */
export function parseRunEvent(data: string): RunEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { seq, type } = payload as { seq?: unknown; type?: unknown }
  if (typeof seq !== 'number' || typeof type !== 'string' || type === '') return null
  return payload as RunEvent
}

/** Merge seq-ordered groups; on an equal seq the later group wins. */
export function orderedUnique(...groups: readonly RunEvent[][]): RunEvent[] {
  // Most updates append live frames after already ordered history pages.
  const appended: RunEvent[] = []
  let lastSeq = -Infinity
  let increasing = true
  for (const group of groups) {
    for (const event of group) {
      if (event.seq <= lastSeq) { increasing = false; break }
      appended.push(event)
      lastSeq = event.seq
    }
    if (!increasing) break
  }
  if (increasing) return appended
  const bySeq = new Map<number, RunEvent>()
  for (const group of groups) {
    for (const event of group) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

type OpenItem = { event: RunEvent; item: Record<string, unknown>; touched: boolean }
const openItemKey = (event: RunEvent, id: unknown) => JSON.stringify([event.stepId ?? null, id])

function appendDelta(open: OpenItem, event: RunEvent): void {
  if (typeof event.delta !== 'string') return
  const field = open.item.kind === 'tool'
    ? event.field === 'output' ? 'output' : undefined
    : event.field !== 'output' && (open.item.kind === 'message' || open.item.kind === 'reasoning') ? 'text' : undefined
  if (!field) return
  const text = open.item[field]
  open.item = { ...open.item, [field]: (typeof text === 'string' ? text : '') + event.delta }
  open.event = { ...open.event, seq: event.seq, ts: event.ts }
}

function closeStep(items: Map<string, OpenItem>, stepId: unknown): void {
  for (const [key, open] of items) if (open.event.stepId === stepId) items.delete(key)
}

function observeOpenItem(items: Map<string, OpenItem>, event: RunEvent, live: boolean): void {
  const item = event.item
  if (event.type === 'item.delta') {
    const open = items.get(openItemKey(event, event.itemId))
    if (open) { appendDelta(open, event); open.touched ||= live }
  } else if (event.type === 'item.completed' && item && typeof item === 'object') {
    items.delete(openItemKey(event, (item as { id?: unknown }).id))
  } else if ((event.type === 'item.started' || event.type === 'item.updated') && item && typeof item === 'object' && 'kind' in item) {
    // A live `item.updated` may be an earlier carried snapshot; a live start is on disk already.
    items.set(openItemKey(event, (item as { id?: unknown }).id), { event, item: item as Record<string, unknown>, touched: live && event.type === 'item.updated' })
  } else if (event.type === 'turn.completed' || event.type === 'session.started' || event.type === 'session.ended') {
    closeStep(items, event.stepId)
  }
}

/**
 * One `item.updated` per item that is still open and that a live delta or snapshot touched, at the seq of
 * its latest event, with the text folded so far: the shape the server's live snapshot sends.
 * `ordered` holds the history and the live tail, so a delta finds an item opened on disk.
 */
export function openItemSnapshots(ordered: readonly RunEvent[], live: readonly RunEvent[]): RunEvent[] {
  const liveSeqs = new Set(live.map(({ seq }) => seq))
  const items = new Map<string, OpenItem>()
  for (const event of ordered) observeOpenItem(items, event, liveSeqs.has(event.seq))
  return [...items.values()].filter(({ touched }) => touched)
    .map(({ event, item }) => ({ ...event, type: 'item.updated', item } as RunEvent))
    .sort((a, b) => a.seq - b.seq)
}

/**
 * Subscribe to one run's event stream and accumulate the raw ordered list.
 *
 * The list resets when `runId` changes (a different run's events are not "earlier state" of
 * this one) and the socket closes on unmount — an EventSource left unclosed retries forever.
 * No reducer cache, no query-client involvement: unlike the global stream, this data belongs
 * to exactly the component that asked for it.
 */
export interface RunEventStreamOptions {
  cursor?: string | undefined
  afterSeq?: number | undefined
  /** Optimized history keeps a bounded live tail; full-replay fallback leaves this absent. */
  maxEvents?: number
  /** Ask the history owner to fold the live prefix into a fresh persisted tail page. */
  compactAt?: number
  onCompact?: () => void
  onReset?: (reason: string, signal: AbortSignal) => Promise<Pick<LiveRunDemand, 'cursor' | 'afterSeq'> | void>
  /**
   * The events kept when the same run's stream restarts at a newer cursor (compaction). Without
   * it the list empties; with it, open items stay on screen until the new stream's snapshot.
   */
  carryOver?: (events: RunEvent[]) => RunEvent[]
}

export function useRunEvents(runId: string | undefined, options: RunEventStreamOptions = {}): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const { cursor, afterSeq = 0, maxEvents, compactAt, onCompact, onReset, carryOver } = options
  const streamOf = useRef<string | undefined>(undefined)
  const carryRef = useRef(carryOver)
  carryRef.current = carryOver

  useEffect(() => {
    const scope = queryScope()
    const stream = runId === undefined ? undefined : `${scope}/${runId}`
    const sameRun = stream !== undefined && streamOf.current === stream
    streamOf.current = stream
    // A different run's events are not earlier state of this one. The same run at a newer
    // cursor keeps what `carryOver` selects, so an open item does not blank for a round trip.
    setEvents((current) => sameRun && carryRef.current ? carryRef.current(current) : [])
    if (!runId) return

    let maxSeq = afterSeq
    let disposed = false
    let compactionRequested = false
    // Carried events are not new: only frames of this subscription count toward compaction.
    let admitted = 0

    // Frames are batched into one state update per animation frame (#881). Every SSE message is
    // its own task, so a per-frame `setEvents` re-rendered the whole thread once per frame: a
    // 1,051-frame replay cost a thousand renders. The 50 ms timer races the animation frame
    // because a hidden tab never runs one, and a buffer must not wait for the tab to return.
    const FLUSH_FALLBACK_MS = 50
    let pending: RunEvent[] = []
    let flushFrame: number | undefined
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const flush = (): void => {
      if (flushFrame !== undefined) globalThis.cancelAnimationFrame?.(flushFrame)
      clearTimeout(flushTimer)
      flushFrame = undefined
      flushTimer = undefined
      if (disposed || pending.length === 0) return
      const batch = pending
      pending = []
      admitted += batch.length
      setEvents((current) => {
        // A snapshot may sit below the tail, and replaces an event of the same seq.
        const next = orderedUnique(current, batch)
        if (
          !compactionRequested &&
          compactAt !== undefined &&
          admitted >= compactAt
        ) {
          compactionRequested = true
          queueMicrotask(() => {
            if (!disposed) onCompact?.()
          })
        }
        return maxEvents === undefined || next.length <= maxEvents ? next : next.slice(-maxEvents)
      })
    }

    const scheduleFlush = (): void => {
      if (flushTimer !== undefined) return
      flushTimer = setTimeout(flush, FLUSH_FALLBACK_MS)
      if (typeof globalThis.requestAnimationFrame === 'function') {
        flushFrame = globalThis.requestAnimationFrame(flush)
      }
    }

    const release = subscribeLive({ kind: 'run', projectId: scope, runId, afterSeq, ...(cursor ? { cursor } : {}) }, {
      frame: frame => {
        if (!('type' in frame)) return
        // A snapshot restores an open item below the high-water mark and never moves it.
        if (frame.type === 'event' && frame.event.seq > maxSeq) maxSeq = frame.event.seq
        else if (frame.type !== 'snapshot') return
        pending.push(frame.event)
        scheduleFlush()
      },
      reset: async (reason, signal) => {
        flush()
        const resume = await onReset?.(reason, signal)
        if (resume) maxSeq = Math.max(maxSeq, resume.afterSeq)
        return resume
      },
    })

    return () => {
      disposed = true
      if (flushFrame !== undefined) globalThis.cancelAnimationFrame?.(flushFrame)
      clearTimeout(flushTimer)
      release()
    }
  }, [runId, cursor, afterSeq, maxEvents, compactAt, onCompact, onReset])

  return events
}
