import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import { Link as RouterLink } from 'react-router'

import type { ApiRun, RunEvent, UiAskQuestion } from '@open-mercato/cezar-api-client'
import { askCardOf, pendingAskOf } from '@open-mercato/cezar-api-client/contract/pending-ask'

import { archiveRun, getRunHistoryContext } from '@/api/client'
import { queryKeys, useProjectRun } from '@/api/queries'
import { runAddress } from '@/api/run-address'
import { ArchiveIcon, XIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { AskCard } from '@/routes/task-thread/ask-card'
import { useAskAnswer } from '@/routes/task-thread/ask-answer'
import { ReviewPanel } from '@/routes/task-thread/review-panel'
import type { ThreadAsk } from '@/routes/task-thread/thread-state'
import { useFinishRun } from '@/routes/task-thread/use-finish-run'

import { fullTimeOf, since, span } from './activity-format'
import type { DecisionRecord } from './activity-queue-model'
import { TONE_INK } from './activity-tone'

/**
 * Right-hand supervision triage drawer for Live Activity (hearsay-tools/squawk#4376):
 * opens the live `AskCard`, `ReviewPanel`, failure inspection/retry, or quick reply
 * without leaving Activity or losing queue scroll position. Uses explicit `projectId`
 * addressing so global `/activity` can triage any project without mutating global API scope.
 */

export interface ActivityTriageDrawerProps {
  record: DecisionRecord | null
  now: number
  onClose: () => void
  onResolved: (runId: string) => void
  onRestoreFocus?: () => void
}

function fullTaskHref(record: Pick<DecisionRecord, 'projectId' | 'runId'>): string {
  return `/p/${encodeURIComponent(record.projectId)}/tasks/${encodeURIComponent(record.runId)}`
}

function toUiQuestion(question: ReturnType<typeof askCardOf> extends infer T ? T extends { questions: (infer Q)[] } ? Q : never : never): UiAskQuestion {
  return {
    ...(question.id !== undefined ? { id: question.id } : {}),
    header: question.header,
    question: question.question,
    ...(question.options !== undefined
      ? {
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description !== undefined ? { description: option.description } : {}),
          })),
        }
      : {}),
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
    ...(question.allowFreeText !== undefined ? { allowFreeText: question.allowFreeText } : {}),
  }
}

function toThreadAsk(run: ApiRun, events: readonly RunEvent[]): ThreadAsk | undefined {
  const pending = pendingAskOf(events)
  if (!pending) return undefined
  const card = askCardOf(pending)
  if (!card) return undefined
  return {
    kind: 'ask',
    id: card.id,
    questions: card.questions.map(toUiQuestion),
    ...(card.context !== undefined ? { context: card.context } : {}),
    resolved: false,
    ...(run.delegation?.role === 'worker' ? { parentRunId: run.delegation.parentRunId } : {}),
  }
}

function QuickReplyFallback({
  run,
  projectId,
  prompt,
  onResolved,
}: {
  run: ApiRun
  projectId: string
  prompt: string
  onResolved: () => void
}) {
  const delivery = useAskAnswer(run, projectId)
  const finish = useFinishRun(run.id, { projectId, onSuccess: onResolved })
  const [text, setText] = useState('')
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    const error = await delivery.send(trimmed)
    if (error === undefined) {
      setText('')
      onResolved()
    }
  }
  return (
    <div data-slot="activity-quick-reply" className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5">
      <p className="text-[13px] text-foreground">{prompt}</p>
      <Textarea
        aria-label="Reply to task"
        placeholder="Write your reply…"
        rows={3}
        value={text}
        disabled={delivery.isPending || delivery.blockedBy !== undefined}
        onChange={(event) => setText(event.target.value)}
        className="bg-background text-base md:text-[13px]"
      />
      {delivery.reason ? <p className="text-xs text-muted-foreground">{delivery.reason}</p> : null}
      {delivery.error ? <p role="alert" className="text-xs text-danger">{delivery.error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="min-h-11"
          disabled={delivery.isPending || delivery.blockedBy !== undefined || text.trim().length === 0}
          onClick={() => void submit()}
        >
          Send reply
        </Button>
        {run.finishBlocked === null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={finish.isPending}
            onClick={() => finish.mutate()}
          >
            Finish task
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function AskDrawerBody({
  record,
  run,
  onResolved,
}: {
  record: DecisionRecord
  run: ApiRun
  onResolved: () => void
}) {
  const contextQuery = useQuery({
    queryKey: [record.projectId, 'run-history-context', record.runId] as const,
    queryFn: ({ signal }) => getRunHistoryContext(record.runId, { projectId: record.projectId, signal }),
  })

  if (contextQuery.isPending) {
    return <p data-slot="triage-loading" className="text-xs text-muted-foreground">Loading question…</p>
  }
  const ask = contextQuery.data ? toThreadAsk(run, contextQuery.data.contextEvents as RunEvent[]) : undefined
  if (ask) {
    return <AskCard ask={ask} run={run} projectId={record.projectId} onAnswered={onResolved} />
  }
  return (
    <QuickReplyFallback
      run={run}
      projectId={record.projectId}
      prompt={record.blockingReason}
      onResolved={onResolved}
    />
  )
}

function FailedDrawerBody({
  record,
  run,
  onResolved,
}: {
  record: DecisionRecord
  run: ApiRun
  onResolved: () => void
}) {
  const queryClient = useQueryClient()
  const delivery = useAskAnswer(run, record.projectId)
  const [retryNote, setRetryNote] = useState('')
  const archive = useMutation({
    mutationFn: () => archiveRun(runAddress(record.runId, { projectId: record.projectId }), true),
    onSuccess: () => {
      toast('Failed task archived.')
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      onResolved()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const retry = async () => {
    const prompt = retryNote.trim() || 'Continue and resolve the failure.'
    const error = await delivery.send(prompt)
    if (error === undefined) {
      toast('Task resumed.')
      onResolved()
    }
  }
  const errorMessage = run.error ?? record.blockingReason
  return (
    <div data-slot="activity-failed-triage" className="flex flex-col gap-3">
      <div className="rounded-lg border border-danger/40 bg-card-2 p-3.5">
        <p className="text-xs font-semibold text-signal-word-red">Failure details</p>
        <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-foreground">
          {errorMessage}
        </pre>
      </div>
      {delivery.mode !== 'unavailable' ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="activity-retry-note" className="text-xs font-medium text-foreground">
            Retry instruction (optional)
          </label>
          <Textarea
            id="activity-retry-note"
            rows={2}
            placeholder="Leave blank to continue and resolve the failure…"
            value={retryNote}
            disabled={delivery.isPending || delivery.blockedBy !== undefined}
            onChange={(event) => setRetryNote(event.target.value)}
            className="bg-card text-base md:text-[13px]"
          />
          {delivery.reason ? <p className="text-xs text-muted-foreground">{delivery.reason}</p> : null}
          {delivery.error ? <p role="alert" className="text-xs text-danger">{delivery.error}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {delivery.mode !== 'unavailable' ? (
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="min-h-11"
            disabled={delivery.isPending || delivery.blockedBy !== undefined}
            onClick={() => void retry()}
          >
            <RotateCcwIcon aria-hidden="true" className="size-3.5" />
            Retry task
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={archive.isPending}
          onClick={() => archive.mutate()}
        >
          <ArchiveIcon aria-hidden="true" className="size-3.5" />
          Archive
        </Button>
      </div>
    </div>
  )
}

function DrawerContentBody({
  record,
  onResolved,
}: {
  record: DecisionRecord
  onResolved: () => void
}) {
  const runQuery = useProjectRun(record.projectId, record.runId, true)
  if (runQuery.isPending) {
    return <p data-slot="triage-loading" className="text-xs text-muted-foreground">Loading task details…</p>
  }
  if (runQuery.isError || !runQuery.data) {
    return (
      <div role="alert" className="flex flex-col gap-2 text-xs text-danger">
        <p>Could not load task details: {runQuery.error?.message ?? 'task unavailable'}.</p>
        <Button type="button" size="sm" variant="outline" className="min-h-11 self-start" onClick={() => void runQuery.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const run = runQuery.data
  if (record.kind === 'answer') return <AskDrawerBody record={record} run={run} onResolved={onResolved} />
  if (record.kind === 'review') return <ReviewPanel run={run} projectId={record.projectId} onResolved={onResolved} />
  if (record.kind === 'failed') return <FailedDrawerBody record={record} run={run} onResolved={onResolved} />
  return (
    <QuickReplyFallback
      run={run}
      projectId={record.projectId}
      prompt={record.blockingReason}
      onResolved={onResolved}
    />
  )
}

export function ActivityTriageDrawer({
  record,
  now,
  onClose,
  onResolved,
  onRestoreFocus,
}: ActivityTriageDrawerProps) {
  const queryClient = useQueryClient()
  const handleResolved = () => {
    if (!record) return
    void queryClient.invalidateQueries({ queryKey: ['workspace', 'activity'] })
    onResolved(record.runId)
  }

  return (
    <Sheet open={record !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-slot="activity-triage-drawer"
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus) {
            event.preventDefault()
            onRestoreFocus()
          }
        }}
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-lg"
      >
        {record ? (
          <>
            <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-border bg-card px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-xs font-semibold', TONE_INK[record.tone])}>{record.stateLabel}</span>
                  <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {record.projectName}
                  </span>
                  {record.ageSince ? (
                    <span title={fullTimeOf(record.ageSince)} className="text-xs text-muted-foreground tabular-nums">
                      {span(since(record.ageSince, now))}
                    </span>
                  ) : null}
                </div>
                <SheetTitle className="mt-1 truncate text-[16px] leading-snug">{record.task.title}</SheetTitle>
                <SheetDescription className="sr-only">
                  Resolve {record.stateLabel.toLowerCase()} for {record.task.title} without leaving Live Activity.
                </SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button asChild size="sm" variant="ghost" className="min-h-11 px-2.5 text-xs">
                  <RouterLink to={fullTaskHref(record)}>
                    Open task
                    <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                  </RouterLink>
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Close triage drawer"
                  className="size-11"
                  onClick={onClose}
                >
                  <XIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <DrawerContentBody key={`${record.projectId}:${record.runId}:${record.kind}`} record={record} onResolved={handleResolved} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
