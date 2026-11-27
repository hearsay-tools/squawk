import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { scheduleLabel } from '@open-mercato/cezar-api-client/contract/automation-schedule'
import { automationFailureNotice } from '@open-mercato/cezar-api-client/contract/automations'
import type { AutomationListEntry, AutomationsResponse, OnceStatus } from '@open-mercato/cezar-api-client'

import { cancelAutomation, checkAutomation, getAutomationCheck, runAutomationNow, setAutomationEnabled } from '@/api/client'
import { CenteredState } from '@/components/centered-state'
import { GithubIcon, PlusIcon, RefreshCwIcon, ZapIcon } from '@/components/design-icons'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { dayTime, relativeIn } from '@/lib/automation-format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { eventsSentence } from './event-phrases'
import { InlineLog } from './log'
import { PageFrame, PageState } from './page-frame'

/** What a card says under its actions: a progress word, a result, or a refusal. */
type Note = { text: string; tone: 'info' | 'error'; runId?: string }

export function AutomationsList({ data, error, refresh, archived = false, onArchivedChange }: {
  data: AutomationsResponse | undefined
  error: string
  refresh: () => Promise<void>
  /** hearsay-tools/cezarion#1465: the list shows only archived one-time schedules. */
  archived?: boolean
  onArchivedChange?: (next: boolean) => void
}) {
  const [notes, setNotes] = useState<Record<string, Note>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const note = (id: string, next: Note | undefined) =>
    setNotes((current) => {
      const { [id]: _dropped, ...rest } = current
      return next ? { ...rest, [id]: next } : rest
    })
  const guard = async (id: string, work: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [id]: true }))
    try { await work() } catch (cause) { note(id, { text: cause instanceof Error ? cause.message : String(cause), tone: 'error' }) } finally { setBusy((current) => ({ ...current, [id]: false })) }
  }

  const runNow = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, { text: 'Starting…', tone: 'info' })
    const { runId } = await runAutomationNow(automation.id)
    note(automation.id, { text: 'Started task', tone: 'info', runId })
    void refresh()
  })
  const toggle = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, undefined)
    await setAutomationEnabled(automation.id, !automation.enabled)
    await refresh()
  })
  const cancel = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, undefined)
    await cancelAutomation(automation.id)
    await refresh()
  })
  const preview = (automation: AutomationListEntry) => guard(automation.id, async () => {
    note(automation.id, { text: 'Checking…', tone: 'info' })
    const { checkId } = await checkAutomation(automation.id, 'preview')
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const check = await getAutomationCheck(checkId)
      if (check.status === 'complete') {
        note(automation.id, { text: `${check.matches ?? 0} filter match${check.matches === 1 ? '' : 'es'} found; no tasks launched. Counts can include closed items and previously processed events.`, tone: 'info' })
        void refresh()
        return
      }
      if (check.status === 'error') throw new Error(check.error ?? 'Preview failed')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('Preview is still running')
  })

  // The route fetches active and archived entries in one list, so both tabs can carry a count
  // the way the Tasks tabs do; the view only picks which of the two it renders.
  const all = data?.automations ?? []
  const activeEntries = all.filter((automation) => !automation.archived)
  const archivedEntries = all.filter((automation) => Boolean(automation.archived))
  const shown = archived ? archivedEntries : activeEntries

  return (
    <PageFrame
      tabbed
      title="Automations"
      subtitle={`Schedules and GitHub checks run while Squawk is open.`}
      action={<Button variant="primary" asChild><Link to="/automations/new"><PlusIcon aria-hidden="true" className="size-4" />New automation</Link></Button>}
    >
      {error && !data ? (
        <div className="grid justify-items-start gap-3"><PageState text={error} /><Button variant="outline" onClick={() => void refresh()}>Retry</Button></div>
      ) : !data ? <PageState text="Loading automations…" /> : (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-border">
            {onArchivedChange ? (
              <div className="flex gap-6" role="group" aria-label="Filter automations">
                <button
                  type="button"
                  data-slot="automations-tab"
                  data-view="active"
                  aria-pressed={!archived}
                  onClick={() => onArchivedChange(false)}
                  className={cn(
                    '-mb-px flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                    !archived && 'border-accent-text text-foreground',
                  )}
                >
                  Active
                  <TabCount count={activeEntries.length} />
                </button>
                <button
                  type="button"
                  data-slot="automations-tab"
                  data-view="archived"
                  aria-pressed={archived}
                  onClick={() => onArchivedChange(!archived)}
                  className={cn(
                    '-mb-px flex min-h-11 items-center justify-center gap-1.5 border-b-2 border-transparent text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                    archived && 'border-accent-text text-foreground',
                  )}
                >
                  Archived
                  <TabCount count={archivedEntries.length} />
                </button>
              </div>
            ) : <span />}
            <div className="pb-2.5">
              <SchedulerStatus data={data} />
            </div>
          </div>
          {archived && shown.length === 0 ? (
            <PageState text="No archived one-time schedules." />
          ) : shown.length === 0 ? (
            <CenteredState
              icon={<ZapIcon />}
              tone="neutral"
              title="No automations yet"
              subtitle="Create one paused, preview it, then enable it."
              heading="h2"
              actions={<Button variant="primary" asChild><Link to="/automations/new"><PlusIcon aria-hidden="true" className="size-4" />New automation</Link></Button>}
            />
          ) : (
            <ul className="grid gap-3" aria-label="Automations">
              {shown.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  timeZone={data.timeZone}
                  note={notes[automation.id]}
                  busy={busy[automation.id] === true}
                  onRun={() => void runNow(automation)}
                  onToggle={() => void toggle(automation)}
                  onPreview={() => void preview(automation)}
                  onCancel={() => void cancel(automation)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </PageFrame>
  )
}

/** A tab's "· N", the Tasks tabs' grammar; nothing for an empty view. */
function TabCount({ count }: { count: number }) {
  if (count === 0) return null
  return <span data-slot="automations-tab-count" className="tabular-nums text-muted-foreground">{`· ${count}`}</span>
}

function SchedulerStatus({ data }: { data: AutomationsResponse }) {
  const tone = data.scheduler.state === 'scheduled' ? 'text-success' : 'text-muted-foreground'
  return (
    <p data-slot="automation-scheduler" className={cn('text-xs break-words', tone)}>
      {`Scheduler ${data.scheduler.state === 'scheduled' ? 'running' : 'idle'} · GitHub ${data.available ? 'available' : 'unavailable'}${data.reason ? ` · ${data.reason}` : ''} · ${data.timeZone}`}
    </p>
  )
}

/** `scheduleLabel` for a schedule; the event list and poll interval for a GitHub check. */
function triggerLabel(automation: AutomationListEntry): string {
  if (automation.kind === 'schedule' && automation.schedule) return scheduleLabel(automation.schedule)
  return `${eventsSentence(automation.events ?? [])} · every ${Math.round((automation.intervalSeconds ?? 300) / 60)} min`
}

/** A one-time schedule's status badge: the words and the dot tone (hearsay-tools/cezarion#1465). */
const ONCE_BADGE: Record<OnceStatus, { label: string; dot: 'success' | 'neutral' | 'danger' | 'pending' }> = {
  waiting: { label: 'Waiting', dot: 'success' },
  paused: { label: 'Paused', dot: 'neutral' },
  failed: { label: 'Failed', dot: 'danger' },
  missed: { label: 'Missed', dot: 'pending' },
  archived: { label: 'Archived', dot: 'neutral' },
}

/** A one-time schedule's status badge, or undefined when the card shows live Enabled/Paused. */
function badgeFor(automation: AutomationListEntry): (typeof ONCE_BADGE)[OnceStatus] | undefined {
  if (automation.schedule?.type !== 'once') return undefined
  return ONCE_BADGE[automation.onceStatus ?? (automation.enabled ? 'waiting' : 'paused')]
}

/** The card head: kind icon, name, one metadata line (trigger · next run), and the status pill. */
function AutomationCardHead({ automation, badge, nextRun }: {
  automation: AutomationListEntry
  badge: (typeof ONCE_BADGE)[OnceStatus] | undefined
  /** The next-run part of the metadata line; absent on an archived card. */
  nextRun?: ReactNode
}) {
  const KindIcon = automation.kind === 'schedule' ? RefreshCwIcon : GithubIcon
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-semibold break-words"><KindIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{automation.name}</h2>
        {/* One metadata line at one size: the trigger and the next run read as one sentence. */}
        <p data-slot="automation-meta" className="mt-1 flex flex-wrap items-baseline gap-x-1.5 ps-6 text-xs break-words text-muted-foreground">
          <span>{triggerLabel(automation)}</span>
          {nextRun ? <><span aria-hidden="true">·</span>{nextRun}</> : null}
        </p>
      </div>
      {badge
        ? <Pill dot={badge.dot}>{badge.label}</Pill>
        : <Pill dot={automation.enabled ? 'success' : 'neutral'}>{automation.enabled ? 'Enabled' : 'Paused'}</Pill>}
    </div>
  )
}

/** The archived record: what happened, the task it started, and the Details link. */
function ArchiveRecord({ automation, archive }: {
  automation: AutomationListEntry
  archive: NonNullable<AutomationListEntry['archived']>
}) {
  return (
    <>
      <p className="text-sm break-words">
        {archive.outcome === 'launched' ? 'Started its task.' : 'Cancelled — no task was started.'}
        {archive.runId ? <> · <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={`/tasks/${archive.runId}`}>Open task</Link></> : null}
      </p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link to={`/automations/${automation.id}`}>Details</Link></Button></div>
    </>
  )
}

/** The next-run part of a live card's metadata line: continuous, the armed time, or the em dash. */
function NextRunMeta({ automation, timeZone }: {
  automation: AutomationListEntry
  timeZone: string
}) {
  const isSchedule = automation.kind === 'schedule'
  const nextAt = automation.enabled && isSchedule ? automation.nextRunAt : undefined
  if (!isSchedule && automation.enabled) return <span>continuous</span>
  if (!nextAt) return <span>Next run: —</span>
  return (
    <>
      <span className="text-foreground">{`Next run: ${dayTime(nextAt, timeZone)}`}</span>
      <span>{`· ${relativeIn(Date.now(), Date.parse(nextAt))}`}</span>
    </>
  )
}

/** An enabled GitHub poll whose recent checks all failed: how many, the last error, the next try. */
function FailureNotice({ automation, timeZone }: { automation: AutomationListEntry; timeZone: string }) {
  const failure = automation.enabled ? automationFailureNotice(automation.state) : undefined
  if (!failure) return null
  return (
    <p role="alert" data-slot="automation-failing" className="text-sm break-words text-destructive">
      {`The last ${failure.consecutiveFailures} checks failed: ${failure.lastError}`}
      {failure.retryAt ? <span className="text-muted-foreground">{` · Next try ${dayTime(failure.retryAt, timeZone)}`}</span> : null}
    </p>
  )
}

/** A card action: 32px where a pointer hovers, the 44px touch target where it cannot. */
const CARD_ACTION = 'h-8 px-3 max-md:h-11 no-hover:h-11'

/** The actions row of a live card: toggle, run/preview, edit, cancel, and the log at the far end. */
function CardActions({ automation, busy, confirmingCancel, cancelRef, onToggle, onRun, onPreview, onOpenCancel }: {
  automation: AutomationListEntry
  busy: boolean
  confirmingCancel: boolean
  cancelRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  onRun: () => void
  onPreview: () => void
  onOpenCancel: () => void
}) {
  const isSchedule = automation.kind === 'schedule'
  const isOnce = automation.schedule?.type === 'once'
  return (
    // One button grammar: compact bordered buttons whose left edge lines up with the card's text.
    // The state change leads; Enable on a paused card carries the accent so the next step reads first.
    <div data-slot="automation-actions" className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className={cn(CARD_ACTION, !automation.enabled && 'border-accent-text/50 text-accent-text')}
        data-action="automation-toggle"
        disabled={busy}
        onClick={onToggle}
      >
        {automation.enabled ? 'Pause' : 'Enable'}
      </Button>
      {isSchedule
        ? <Button variant="outline" size="sm" className={CARD_ACTION} data-action="automation-run" disabled={busy} onClick={onRun}>Run now</Button>
        : <Button variant="outline" size="sm" className={CARD_ACTION} data-action="automation-preview" disabled={busy} onClick={onPreview}>Test filter</Button>}
      <Button variant="outline" size="sm" className={CARD_ACTION} asChild><Link to={`/automations/${automation.id}`}>Edit</Link></Button>
      {isOnce && !confirmingCancel ? <Button variant="outline" size="sm" className={cn(CARD_ACTION, 'text-destructive')} ref={cancelRef} data-action="automation-cancel" disabled={busy} onClick={onOpenCancel}>Cancel</Button> : null}
      <Button variant="outline" size="sm" className={cn(CARD_ACTION, 'sm:ms-auto')} asChild><Link to={`/automations/${automation.id}/log`}>Execution log</Link></Button>
    </div>
  )
}

/** The confirm block while a one-time schedule's cancel is pending. */
function CancelConfirm({ automation, busy, keepRef, onConfirm, onKeep }: {
  automation: AutomationListEntry
  busy: boolean
  keepRef: RefObject<HTMLButtonElement | null>
  onConfirm: () => void
  onKeep: () => void
}) {
  return (
    <div className="grid justify-items-start gap-2">
      <p className="text-sm break-words">{`Cancel “${automation.name}”? It will never run, and it moves to Archived.`}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger-ghost" data-action="automation-cancel-confirm" disabled={busy} onClick={onConfirm}>Cancel schedule</Button>
        <Button ref={keepRef} variant="outline" disabled={busy} onClick={onKeep}>Keep</Button>
      </div>
    </div>
  )
}

/** The card's note paragraph: a progress word, a result, or a refusal. */
function CardNote({ note }: { note: Note }) {
  return (
    <p role={note.tone === 'error' ? 'alert' : 'status'} className={cn('text-sm break-words', note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      {note.text}
      {note.runId ? <> · <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={`/tasks/${note.runId}`}>Open task</Link></> : null}
    </p>
  )
}

function AutomationCard({ automation, timeZone, note, busy, onRun, onToggle, onPreview, onCancel }: {
  automation: AutomationListEntry
  timeZone: string
  note?: Note | undefined
  busy: boolean
  onRun: () => void
  onToggle: () => void
  onPreview: () => void
  onCancel: () => void
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  // Cancel and its confirm replace each other, so focus follows: to Keep when the confirm opens,
  // back to Cancel when Keep closes it. Without this, a keyboard user lands on <body>.
  const cancelRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const focusAfter = useRef<'keep' | 'cancel' | null>(null)
  useEffect(() => {
    const target = focusAfter.current === 'keep' ? keepRef.current : focusAfter.current === 'cancel' ? cancelRef.current : null
    focusAfter.current = null
    target?.focus()
  }, [confirmingCancel])
  const openCancel = () => { focusAfter.current = 'keep'; setConfirmingCancel(true) }
  const keep = () => { focusAfter.current = 'cancel'; setConfirmingCancel(false) }
  const archive = automation.archived
  return (
    <li data-slot="automation-card" data-kind={automation.kind} className="flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-4">
      <AutomationCardHead
        automation={automation}
        badge={badgeFor(automation)}
        nextRun={archive ? undefined : <NextRunMeta automation={automation} timeZone={timeZone} />}
      />
      {archive ? <ArchiveRecord automation={automation} archive={archive} /> : null}
      {archive ? null : <FailureNotice automation={automation} timeZone={timeZone} />}
      {archive ? null : (
        <CardActions
          automation={automation}
          busy={busy}
          confirmingCancel={confirmingCancel}
          cancelRef={cancelRef}
          onToggle={onToggle}
          onRun={onRun}
          onPreview={onPreview}
          onOpenCancel={openCancel}
        />
      )}
      {automation.schedule?.type === 'once' && !archive && confirmingCancel ? (
        <CancelConfirm
          automation={automation}
          busy={busy}
          keepRef={keepRef}
          onConfirm={() => { setConfirmingCancel(false); onCancel() }}
          onKeep={keep}
        />
      ) : null}
      {note ? <CardNote note={note} /> : null}
      <InlineLog automationId={automation.id} automationName={automation.name} timeZone={timeZone} />
    </li>
  )
}
