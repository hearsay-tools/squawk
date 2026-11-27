import './session-layout.css'
import { deriveAttention } from '@/lib/attention'
import { MessageSquareTextIcon, SearchXIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useParams } from 'react-router'

import { Link, useActiveProjectId } from '@/lib/project-router'

import { useQuery } from '@tanstack/react-query'
import { ApiError, getRuns } from '@/api/client'
import { projectAddress } from '@/api/run-address'
import {
  useEditQueuedMessage,
  useMarkRunSeen,
  usePatchRun,
  useRemoveQueuedMessage,
  useRun,
  useProjectRepoBase,
  useRuns,
  queryKeys,
  useRunRelationships,
  useSendMessage,
} from '@/api/queries'
import { useRunHistory, type RunHistoryState } from '@/api/run-history'
import { pendingAskOf } from '@open-mercato/cezar-api-client/contract/pending-ask'
import { removedRunnerMessage } from '@open-mercato/cezar-api-client/contract/runner'
import { asksQuestion } from '@open-mercato/cezar-api-client/contract/waits'
import { runTitle } from '@/lib/task-groups'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { ReadingPage } from '@/components/page-shell'
import { RunDiff } from '@/components/run-diff'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { useKeyboardInsetVar } from '@/lib/keyboard-inset'
import { isUnread } from '@/lib/read-state'
import { taskIssueUrl, taskPrUrl } from '@/lib/tasks-table'
import { cn, isHttpUrl } from '@/lib/utils'

import { WorkingIndicator } from './thread-items'
import { useContinueAction } from './follow-up-engine'
import { findSubagent, subagentEntries } from './subagent-dock'
import { SubagentSheet } from './subagent-sheet'
import { AcceptCelebration } from './review-panel'
import { hasLiveSession, queuePosition } from './run-actions'
import { useFinishRun } from './use-finish-run'
import { useStopAction } from './stop-action'
import { RunHeader } from './run-header'
import { RunActivityDock } from './run-activity-dock'
import {
  DesktopActivityHeaderControl,
  MobileActivityHeaderControl,
  ULTRAWIDE_ACTIVITY_QUERY,
} from './run-activity-header'
import { AskCard, AskContext } from './ask-card'
import { PermissionCard } from './permission-card'
import { useAskAnswer } from './ask-answer'
import { useRunRecordReconcile } from './run-reconcile'
import { useActiveProviderAvailability } from './active-provider'
import { ThreadLoading } from './thread-loading'
import { threadRenderMode } from './thread-scroll'
import { useThreadScroll, type ThreadScrollControls } from './thread-scroller'
import { AskOriginMarker, pinnedAnswerControl, pinnedAskFocus } from './pending-ask-navigation'
import { useRevealAskOrigin } from './use-reveal-ask-origin'
import { useSessionViewport } from './session-viewport'
import { ThreadDecisionZone } from './decision-zone'
import { usePreviewPane } from './preview/preview-state'
import { useMediaQuery } from './preview/use-media-query'
import {
  SessionTranscript,
  buildTranscriptRows,
  findPendingThreadAsk,
  mainTranscriptSections,
  type TranscriptMessageActions,
} from './session-transcript'
import { recipientBackendsFromRuns, titlesFromRuns } from './conversation-presentation'
import {
  reduceThread,
  threadFooter,
  type ThreadAsk,
  type ThreadPermission,
  type ThreadState,
} from './thread-state'

/**
 * `/tasks/:id` — the Session tab (spec, "Task thread", viewport-locked in hearsay-tools/squawk#4374):
 * the run header (title, Activity status trigger, tabs, actions), an independently scrollable
 * transcript region, an optional ultra-wide Activity right sidebar, and a fixed bottom decision
 * zone rendering the single active human action for the current task state.
 */
export function TaskThreadRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const history = useRunHistory(id)
  const runStatus = run.data?.status
  const thread = useMemo(
    () => reduceThread(history.visibleEvents, { activeTurn: runStatus === 'running' }),
    [history.visibleEvents, runStatus],
  )
  const currentThread = useMemo(
    () => reduceThread(history.currentEvents, { activeTurn: runStatus === 'running' }),
    [history.currentEvents, runStatus],
  )

  const suppressAutoRead = useRef<string | undefined>(undefined)
  const suppressAutoReadFor = useCallback((runId: string) => {
    suppressAutoRead.current = runId
  }, [])
  const { mutate: markRunSeen } = useMarkRunSeen()
  useEffect(() => {
    if (!run.data) return
    if (suppressAutoRead.current === run.data.id) return
    if (isUnread(run.data)) markRunSeen(run.data.id)
  }, [
    markRunSeen,
    run.data?.id,
    run.data?.status,
    run.data?.finishedAt,
    run.data?.seenAt,
    run.data?.archived,
  ])
  useRunRecordReconcile(run.data, history.visibleEvents)

  if (run.isPending) return <ThreadLoading />

  if (run.isError) {
    const notFound = run.error instanceof ApiError && run.error.status === 404
    return (
      <ReadingPage route="task-thread" density="empty" flushPadding>
        <CenteredState
          icon={notFound ? <SearchXIcon /> : <MessageSquareTextIcon />}
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Task not found' : 'Could not load this task'}
          subtitle={
            notFound
              ? 'No run has this id. It may have been deleted, or the link is from another machine.'
              : run.error.message
          }
          actions={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </ReadingPage>
    )
  }

  if (history.isPending) return <ThreadLoading />

  return (
    <ThreadView
      run={run.data}
      thread={thread}
      currentThread={currentThread}
      history={history}
      onMarkedUnread={suppressAutoReadFor}
    />
  )
}

/** Query structural sharing keeps token/usage-only list updates out of the transcript. */
const selectThreadRuns = (runs: RunSummary[]) => ({
  titles: Object.fromEntries(runs.map(run => [run.id, runTitle(run)])),
  backends: Object.fromEntries(runs.map(run => [run.id, run.currentStepBackend ?? run.runner])),
})

/** The loaded thread. The header owns its own data hooks (mutations, the runs list); the
 *  thread body stays presentational — tests drive it with reduced fixture states directly. */
export function ThreadView({
  run,
  thread,
  currentThread = thread,
  history,
  onMarkedUnread,
}: {
  run: ApiRun
  thread: ThreadState
  currentThread?: ThreadState
  history?: RunHistoryState | undefined
  onMarkedUnread?: ((runId: string) => void) | undefined
}) {
  useActiveProjectId()
  const runs = useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: ({ signal }) => getRuns(projectAddress(), { signal }),
    select: selectThreadRuns,
  })
  const { pendingAsk, transcriptAsk, pendingAskId, historyLoading } = pendingThreadAsk(history, currentThread)
  const attention = deriveAttention(run)
  const footer = threadFooter(run.status, run.error, thread)
  const sessionOpen = hasLiveSession(run)
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  const queued = run.status === 'queued'
  const continueAction = useContinueAction(run)
  const stopAction = useStopAction(run)
  const finishAction = useFinishRun(run.id)
  const needsAnswer = transcriptAsk || asksQuestion(run)
  const { hasContinuation, continuable } = threadContinuation(sessionOpen, queued, continueAction)

  const { openAgentId, setOpenAgentId, activityMode, activityOpen, setActivityOpen, showActivitySidebar } = useThreadChromeState(run.id)
  const { openAgent, openAgentChildren } = useOpenSubagent(openAgentId, currentThread, thread, runIsTerminal)
  const sendMessage = useSendMessage(run.id)
  const reply = useAskAnswer(run)
  const activeProvider = useActiveProviderAvailability(run)
  const { providerBlocked, providerReason } = threadProviderState(sessionOpen, activeProvider, hasContinuation, continueAction)
  const messageActions = useQueuedMessageActions(run, queued)

  const sectionsAskId = historyLoading ? undefined : (pendingAskId ?? null)
  const pinnedAsk = useMemo(
    () => findPendingThreadAsk(currentThread, sectionsAskId),
    [currentThread, sectionsAskId],
  )
  const pendingQuestions = pinnedAsk?.questions.length ?? 0
  const sections = useMemo(
    () => mainTranscriptSections(run, thread, currentThread, sectionsAskId, { pinPendingAskInTranscript: false }),
    [run, thread, currentThread, sectionsAskId],
  )
  const rows = useMemo(() => buildTranscriptRows(sections, run.id), [sections, run.id])

  const { taskTitles, recipientBackends } = useThreadTaskMetadata(run, runs.data)
  const renderPermission = useCallback((permission: ThreadPermission) => <PermissionCard permission={permission} runId={run.id} sessionOpen={sessionOpen} />, [run.id, sessionOpen])
  const removedRunnerNotice = continuable && run.removedRunner !== undefined ? removedRunnerMessage(run.removedRunner) : undefined

  const issueUrl = taskIssueUrl(run, useProjectRepoBase())
  const { search } = useLocation()
  const mode = threadRenderMode(search, rows.length)
  const scroll = useThreadScroll(`${run.id}:main`, {
    onLoadOlder: history?.hasOlder ? history.loadOlder : undefined,
    onJumpToLatest: history?.jumpToLatest,
    rowKeys: rows.map(({ key }) => key),
  })
  const revealOrigin = useRevealAskOrigin({
    pendingAskId,
    askSeq: history ? pendingAsk?.seq : undefined,
    rows,
    history,
    jumpToRow: scroll.jumpToRow,
  })
  const settledAskIdRef = useRef(pendingAskId)
  if (!historyLoading) settledAskIdRef.current = pendingAskId
  const viewportRef = useSessionViewport()
  const navigationRef = useRef({ reveal: revealOrigin.reveal })
  navigationRef.current = { reveal: revealOrigin.reveal }

  const focusPinnedQuestion = useCallback(() => {
    const root = viewportRef.current ?? document.body
    const target = pinnedAnswerControl(root)
    target?.focus({ preventScroll: true })
  }, [viewportRef])

  const renderAsk = useCallback((ask: ThreadAsk) => {
    if (ask.placement === 'origin') {
      return (
        <div className="flex flex-col gap-3">
          {ask.context ? <AskContext text={ask.context} /> : null}
          {!ask.resolved ? <AskOriginMarker onGoToQuestion={focusPinnedQuestion} /> : null}
        </div>
      )
    }
    return <AskCard ask={ask} run={run} onShowOrigin={() => navigationRef.current.reveal()} />
  }, [run, focusPinnedQuestion])

  useKeyboardInsetVar(scroll.restickIfStuck)
  const currentComplete = history?.currentComplete ?? true
  const activityControlProps = {
    run,
    thread,
    currentThread,
    currentComplete,
    onOpenWorker: setOpenAgentId,
    mode: activityMode,
    open: activityOpen,
    onOpenChange: setActivityOpen,
  }

  return (
    <ReadingPage
      route="task-thread"
      density={thread.turns.length === 0 ? 'empty' : 'full'}
      fillHeight
      flushPadding
      rootRef={viewportRef}
      rootProps={{ 'data-run-id': run.id }}
      className="overflow-clip"
    >
      <RunHeader
        run={run}
        onMarkedUnread={() => onMarkedUnread?.(run.id)}
        desktopActivitySlot={<DesktopActivityHeaderControl {...activityControlProps} />}
        mobileActivitySlot={<MobileActivityHeaderControl {...activityControlProps} />}
      />

      <div data-slot="thread-workspace">
        <div data-slot="thread-main">
          <div data-slot="thread-transcript">
            <ThreadTranscript
              run={run}
              thread={thread}
              history={history}
              footer={footer}
              issueUrl={issueUrl}
              sections={sections}
              renderAsk={renderAsk}
              renderPermission={renderPermission}
              messageActions={messageActions}
              scroll={scroll}
              mode={mode}
              taskTitles={taskTitles}
              recipientBackends={recipientBackends}
            />
          </div>

          <ThreadDecisionZone
            run={run}
            thread={thread}
            pinnedAsk={pinnedAsk}
            pendingQuestions={pendingQuestions}
            scroll={scroll}
            onJump={() => {
              const askId = pendingQuestions > 0 ? pinnedAsk?.id : undefined
              scroll.jumpToLatest(askId === undefined ? undefined : pinnedAskFocus(askId, () => settledAskIdRef.current === askId))
            }}
            onShowOrigin={() => navigationRef.current.reveal()}
            sessionOpen={sessionOpen}
            attention={attention}
            queued={queued}
            continuable={continuable}
            continueAction={continueAction}
            stopAction={stopAction}
            finishAction={finishAction}
            needsAnswer={needsAnswer}
            sendMessage={sendMessage}
            reply={reply}
            providerBlocked={providerBlocked}
            providerReason={providerReason}
            removedRunnerNotice={removedRunnerNotice}
          />
        </div>

        {showActivitySidebar ? (
          <aside data-slot="thread-activity-sidebar" aria-label="Session activity">
            <RunActivityDock
              presentation="panel"
              run={run}
              thread={thread}
              currentThread={currentThread}
              currentComplete={currentComplete}
              onOpenWorker={setOpenAgentId}
            />
          </aside>
        ) : null}
      </div>

      <AcceptCelebration status={run.status} />

      <SubagentSheet
        runId={run.id}
        renderAsk={renderAsk}
        renderPermission={renderPermission}
        agent={openAgent}
        entries={openAgentChildren}
        taskTitles={taskTitles}
        recipientBackends={recipientBackends}
        onClose={() => setOpenAgentId(undefined)}
      />
    </ReadingPage>
  )
}

function useOpenSubagent(
  openAgentId: string | undefined,
  currentThread: ThreadState,
  thread: ThreadState,
  runIsTerminal: boolean,
) {
  const openAgent = useMemo(
    () =>
      openAgentId === undefined ?
        undefined
      : findSubagent(currentThread.turns, openAgentId, runIsTerminal, thread.turns),
    [currentThread.turns, openAgentId, runIsTerminal, thread.turns],
  )
  const openAgentChildren = useMemo(
    () => (openAgentId === undefined ? [] : subagentEntries(thread.turns, currentThread.turns, openAgentId)),
    [thread.turns, currentThread.turns, openAgentId],
  )
  return { openAgent, openAgentChildren }
}

function useThreadTaskMetadata(
  run: ApiRun,
  runsData: ReturnType<typeof selectThreadRuns> | undefined,
) {
  const delegated = run.delegation?.role === 'root' || run.delegation?.role === 'worker'
  const relationships = useRunRelationships(run.id, { enabled: delegated })
  const taskTitles = useMemo(
    () => ({ ...titlesFromRuns(run, undefined, relationships.data?.titles), ...runsData?.titles, [run.id]: runTitle(run) }),
    [run, runsData, relationships.data],
  )
  const recipientBackends = useMemo(
    () => ({ ...runsData?.backends, ...recipientBackendsFromRuns(run, undefined) }),
    [run, runsData],
  )
  return { taskTitles, recipientBackends }
}

function useThreadChromeState(runId: string) {
  const [openAgentId, setOpenAgentId] = useState<string | undefined>(undefined)
  const [activityPopoverOpen, setActivityPopoverOpen] = useState(false)
  const [activitySidebarOpen, setActivitySidebarOpen] = useState(true)
  const [selectionRunId, setSelectionRunId] = useState(runId)
  if (selectionRunId !== runId) {
    setSelectionRunId(runId)
    setOpenAgentId(undefined)
    setActivityPopoverOpen(false)
  }
  const previewPane = usePreviewPane()
  const ultrawide = useMediaQuery(ULTRAWIDE_ACTIVITY_QUERY, false)
  const activityMode: 'popover' | 'sidebar' = ultrawide && previewPane?.open !== true ? 'sidebar' : 'popover'
  const activityOpen = activityMode === 'sidebar' ? activitySidebarOpen : activityPopoverOpen
  const setActivityOpen = activityMode === 'sidebar' ? setActivitySidebarOpen : setActivityPopoverOpen
  const showActivitySidebar = activityMode === 'sidebar' && activitySidebarOpen
  return { openAgentId, setOpenAgentId, activityMode, activityOpen, setActivityOpen, showActivitySidebar }
}

function useQueuedMessageActions(
  run: ApiRun,
  queued: boolean,
): Readonly<Record<string, TranscriptMessageActions>> | undefined {
  const { mutateAsync: patchRunAsync } = usePatchRun(run.id)
  const { mutateAsync: editQueuedAsync } = useEditQueuedMessage(run.id)
  const { mutateAsync: removeQueuedAsync } = useRemoveQueuedMessage(run.id)
  return useMemo(() => {
    if (!queued) return undefined
    const actions: Record<string, TranscriptMessageActions> = {
      task: {
        onEdit: async (text: string) => { await patchRunAsync({ task: text }) },
        editLabel: 'Edit the prompt',
      },
    }
    for (const message of run.queuedMessages ?? []) {
      actions[`queued:${message.id}`] = {
        onEdit: (text) => editQueuedAsync({ msgId: message.id, message: { text } }).then(() => undefined),
        onRemove: () => removeQueuedAsync(message.id).then(() => undefined),
      }
    }
    return actions
  }, [queued, run.queuedMessages, patchRunAsync, editQueuedAsync, removeQueuedAsync])
}

/** Compact current-state context is authoritative while history pages may contain old asks. */
function pendingThreadAsk(history: RunHistoryState | undefined, currentThread: ThreadState) {
  const pendingAsk = history ? pendingAskOf(history.currentEvents) : undefined
  const transcriptAsk = history
    ? pendingAsk !== undefined
    : currentThread.turns.some(turn => turn.items.some(item => item.kind === 'ask' && !item.resolved))
  const pendingAskId = history
    ? pendingAsk?.requestId
    : currentThread.turns.flatMap(turn => turn.items).reverse().find(item => item.kind === 'ask' && !item.resolved)?.id
  const historyLoading = history !== undefined && (history.isPending || history.contextPending)
  return { pendingAsk, transcriptAsk, pendingAskId, historyLoading }
}

function threadContinuation(
  sessionOpen: boolean,
  queued: boolean,
  continueAction: ReturnType<typeof useContinueAction>,
) {
  const hasContinuation = !sessionOpen && !queued && continueAction.available
  const continuable = hasContinuation && continueAction.canContinue
  return { hasContinuation, continuable }
}

function threadProviderState(
  sessionOpen: boolean,
  activeProvider: ReturnType<typeof useActiveProviderAvailability>,
  hasContinuation: boolean,
  continueAction: ReturnType<typeof useContinueAction>,
) {
  const activeProviderBlocked = sessionOpen && !activeProvider.usable
  const continuationProviderBlocked = hasContinuation && !continueAction.canContinue
  const providerBlocked = activeProviderBlocked || continuationProviderBlocked
  const providerReason = activeProviderBlocked ? activeProvider.reason : continueAction.reason
  return { providerBlocked, providerReason }
}

type ThreadTranscriptProps = {
  sections: ReturnType<typeof mainTranscriptSections>
  renderAsk: (ask: ThreadAsk) => ReactNode
  renderPermission: (permission: ThreadPermission) => ReactNode
  messageActions: Readonly<Record<string, TranscriptMessageActions>> | undefined
  taskTitles: ReturnType<typeof titlesFromRuns>
  recipientBackends: ReturnType<typeof recipientBackendsFromRuns>
  run: ApiRun
  thread: ThreadState
  history?: RunHistoryState | undefined
  footer: ReturnType<typeof threadFooter>
  issueUrl: string | undefined
  scroll: ThreadScrollControls
  mode: ReturnType<typeof threadRenderMode>
}

function ThreadTranscript({
  run, thread, history, footer, issueUrl, sections, renderAsk, renderPermission,
  messageActions, scroll, mode, taskTitles, recipientBackends,
}: ThreadTranscriptProps) {
  return (
    <div data-slot="session-conversation" className="mx-auto flex w-full max-w-[var(--measure)] flex-1 flex-col gap-2.5 px-[18px] py-3 [padding-block-end:12px] md:gap-3.5 md:px-16 md:py-5 md:[padding-block-end:24px]">
      {history ? (
        <HistoryBoundary
          hasOlder={history.hasOlder}
          loading={history.isFetchingOlder}
          error={history.olderError}
          fallback={history.fallback}
          retainedPages={history.retainedPages}
          onLoad={scroll.loadOlder}
        />
      ) : null}
      <SessionTranscript
        runId={run.id}
        viewId="main"
        sections={sections}
        mode="document"
        renderAsk={renderAsk}
        renderPermission={renderPermission}
        messageActions={messageActions}
        scrollControls={scroll}
        renderMode={mode}
        taskTitles={taskTitles}
        recipientBackends={recipientBackends}
      />

      {thread.turns.length === 0 ? (
        run.status === 'queued' ? (
          <QueuedPlaceholder run={run} />
        ) : (
          <p data-slot="thread-empty" className="py-6 text-center text-xs text-soft-foreground">
            No session events yet.
          </p>
        )
      ) : null}

      {run.status === 'running' ? <WorkingIndicator /> : null}

      {footer && footer.state === 'closed' ? (
        <div
          data-slot="thread-footer"
          data-state={footer.state}
          className={cn(
            'mt-auto flex items-center gap-2 border-t border-border pt-3 text-xs',
            footer.tone === 'danger' ? 'text-danger' : 'text-soft-foreground',
          )}
        >
          {footer.label}
          {isHttpUrl(taskPrUrl(run)) ? (
            <a
              data-slot="pr-link"
              href={taskPrUrl(run)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              PR ↗
            </a>
          ) : null}
          {isHttpUrl(issueUrl) ? (
            <a
              data-slot="issue-link"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              Issue ↗
            </a>
          ) : null}
        </div>
      ) : null}

      {/* Review gate diff stays inside the scrollable transcript; the compact review action bar
          lives in the fixed bottom DecisionZone (hearsay-tools/squawk#4374). */}
      {run.status === 'review' ? <RunDiff runId={run.id} /> : null}
    </div>
  )
}

function HistoryBoundary({
  hasOlder,
  loading,
  error,
  fallback,
  retainedPages,
  onLoad,
}: {
  hasOlder: boolean
  loading: boolean
  error?: string | undefined
  fallback: boolean
  retainedPages: number
  onLoad: () => void
}) {
  if (fallback) {
    return (
      <p data-slot="history-fallback" className="text-center text-xs text-soft-foreground" role="status">
        Progressive history is unavailable; showing the complete session.
      </p>
    )
  }
  if (!hasOlder && !error) {
    return (
      <div data-slot="history-start" className="flex items-center gap-3 text-[11px] text-soft-foreground">
        <span aria-hidden className="h-px flex-1 bg-border" />
        Start of session
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    )
  }
  return (
    <div
      data-slot="history-boundary"
      data-retained-pages={retainedPages}
      aria-busy={loading}
      className="flex min-h-8 items-center justify-center text-xs text-muted-foreground"
    >
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="rounded-md px-3 py-1.5 font-medium hover:bg-muted disabled:cursor-wait"
      >
        {loading ?
          'Loading 100 earlier items…'
        : error ?
          'Couldn’t load earlier items · Retry'
        : 'Load 100 earlier items'}
      </button>
      <span className="sr-only" aria-live="polite">
        {loading ? 'Loading earlier session history' : error ? error : ''}
      </span>
    </div>
  )
}

function QueuedPlaceholder({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const position = queuePosition(runs.data ?? [], run.id)
  return (
    <div data-slot="queued-state" className="flex flex-col items-center gap-1.5 py-10 text-center">
      <StatusDot tone="neutral" shape="ring" />
      <p className="text-[13px] font-medium">
        Waiting for a free agent slot{position !== undefined ? ` — #${position} in queue` : ''}
      </p>
      <p className="text-xs text-soft-foreground">
        {run.workflow} · starts automatically when a slot frees up
      </p>
    </div>
  )
}
