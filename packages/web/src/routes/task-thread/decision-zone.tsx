import { useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Composer } from '@/components/composer/composer'
import { StatusDot } from '@/components/status-dot'
import type { deriveAttention } from '@/lib/attention'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { AskCard } from './ask-card'
import type { useAskAnswer } from './ask-answer'
import { AutoResumeHint } from './auto-resume-hint'
import type { useContinueAction } from './follow-up-engine'
import { ReviewPanel } from './review-panel'
import { offersComposerFinish, runActionFlags } from './run-actions'
import { useWorkersLive } from './run-relationships'
import { runStatusLine } from './run-status'
import { activeStepIndex, railSteps } from './step-rail'
import type { useStopAction } from './stop-action'
import { JumpToLatestPill, type ThreadScrollControls } from './thread-scroller'
import { threadFilePaths, type ThreadAsk, type ThreadState } from './thread-state'
import type { useFinishRun } from './use-finish-run'
import type { useSendMessage } from '@/api/queries'

export interface ThreadDecisionZoneProps {
  run: ApiRun
  thread: ThreadState
  pinnedAsk: ThreadAsk | undefined
  pendingQuestions: number
  scroll: ThreadScrollControls
  onJump: () => void
  onShowOrigin: () => void
  sessionOpen: boolean
  attention: ReturnType<typeof deriveAttention>
  queued: boolean
  continuable: boolean
  continueAction: ReturnType<typeof useContinueAction>
  stopAction: ReturnType<typeof useStopAction>
  finishAction: ReturnType<typeof useFinishRun>
  needsAnswer: boolean
  sendMessage: ReturnType<typeof useSendMessage>
  reply: ReturnType<typeof useAskAnswer>
  providerBlocked: boolean
  providerReason: string | undefined
  removedRunnerNotice: string | undefined
}

/**
 * Region 2 of the task thread (hearsay-tools/squawk#4374): fixed bottom decision zone
 * rendering the single active human action for the current task state — pending ask (with
 * unified free-text mode), review gate action bar, running composer with one-line status,
 * or terminal follow-up. Keeps one persistent `ThreadComposer` mounted across decision-mode
 * transitions so drafts and pasted attachments survive arriving asks, reply-mode toggles,
 * and review gates, while keeping the composer's Send/Stop toolbar pinned at the bottom.
 */
export function ThreadDecisionZone(props: ThreadDecisionZoneProps) {
  const {
    run, thread, pinnedAsk, pendingQuestions, scroll, onJump, onShowOrigin,
    sessionOpen, attention, queued, continuable, continueAction,
    stopAction, finishAction, needsAnswer, sendMessage, reply,
    providerBlocked, providerReason, removedRunnerNotice,
  } = props

  const workersLive = useWorkersLive(run)
  const canStop = runActionFlags(run, workersLive).cancel
  const hasPendingAsk = pinnedAsk !== undefined
  const isReviewGate = !hasPendingAsk && run.status === 'review'

  const [askModeState, setAskModeState] = useState<{ askId: string | undefined; mode: 'options' | 'reply' }>({
    askId: pinnedAsk?.id,
    mode: 'options',
  })
  const askMode = askModeState.askId === pinnedAsk?.id ? askModeState.mode : 'options'
  const setAskMode = (mode: 'options' | 'reply') => setAskModeState({ askId: pinnedAsk?.id, mode })

  const unifiedReplyActive = hasPendingAsk && askMode === 'reply'
  const composerHidden = isReviewGate || (hasPendingAsk && askMode === 'options')

  return (
    <div
      data-slot="thread-dock"
      data-pending-ask={needsAnswer || undefined}
      data-decision-mode={hasPendingAsk ? 'ask' : isReviewGate ? 'review' : 'composer'}
      className="relative z-10 shrink-0 bg-background py-1.5 md:pt-2.5 md:pb-4"
    >
      {scroll.pillVisible ? (
        <div data-slot="thread-jump" className="pointer-events-none z-30 flex justify-center">
          <JumpToLatestPill pendingQuestions={pendingQuestions} onJump={onJump} />
        </div>
      ) : null}

      <div
        data-slot="thread-footer-content"
        className={cn(
          'mx-auto flex w-full min-w-0 max-w-[var(--measure)] flex-col px-[14px] md:px-16',
          unifiedReplyActive ? 'gap-0' : 'gap-1.5 md:gap-2',
        )}
      >
        {!isReviewGate ? (
          <>
            <AutoResumeHint run={run} />
            <DecisionStatusLine
              run={run}
              sessionOpen={sessionOpen}
              attention={attention}
              queued={queued}
              continuable={continuable}
              startsNewConversation={continueAction.startsNewConversation}
              removedRunnerNotice={removedRunnerNotice}
            />
          </>
        ) : null}

        {hasPendingAsk ? (
          <AskCard
            key={pinnedAsk.id}
            ask={{ ...pinnedAsk, placement: 'pinned' }}
            run={run}
            surface="decision-zone"
            mode={askMode}
            onModeChange={setAskMode}
            hideReplyBody
            onShowOrigin={onShowOrigin}
            onStop={canStop ? stopAction.stop : undefined}
            stopping={stopAction.stopping}
          />
        ) : isReviewGate ? (
          <ReviewPanel run={run} showDiff={false} />
        ) : null}

        <div
          data-slot="thread-composer-slot"
          hidden={composerHidden}
          className={cn(
            'min-w-0 w-full',
            composerHidden && 'hidden',
            unifiedReplyActive &&
              'rounded-b-xl border border-t-0 border-accent-strong/30 bg-accent-strong/[0.04] p-2.5 [html:not(.light)_&]:bg-card',
          )}
        >
          <ThreadComposer
            run={run}
            thread={thread}
            canStop={canStop}
            hasPendingAsk={hasPendingAsk}
            stopAction={stopAction}
            finishAction={finishAction}
            attention={attention}
            needsAnswer={needsAnswer}
            continuable={continuable}
            continueAction={continueAction}
            queued={queued}
            sendMessage={sendMessage}
            reply={reply}
            providerBlocked={providerBlocked}
            providerReason={providerReason}
            sessionOpen={sessionOpen}
          />
        </div>
      </div>
    </div>
  )
}

function DecisionStatusLine({
  run,
  sessionOpen,
  attention,
  queued,
  continuable,
  startsNewConversation,
  removedRunnerNotice,
}: {
  run: ApiRun
  sessionOpen: boolean
  attention: ReturnType<typeof deriveAttention>
  queued: boolean
  continuable: boolean
  startsNewConversation: boolean
  removedRunnerNotice: string | undefined
}) {
  if (run.status === 'waiting' && sessionOpen) {
    return (
      <div
        data-slot="paused-hint"
        className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
      >
        <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} />
        {
          // oxlint-disable-next-line cez/attention-bucket-compare-outside-owner -- the composer explains permission approval separately
          attention.bucket === 'permission' ? 'Choose an approval option above to continue'
          // oxlint-disable-next-line cez/attention-bucket-compare-outside-owner -- the composer distinguishes a waiting reply
          : attention.bucket === 'waiting' ? 'The agent is paused, waiting for your reply'
            : `${attention.label.charAt(0).toUpperCase()}${attention.label.slice(1)} — you can send a message to resume`}
      </div>
    )
  }

  if (run.status === 'running') {
    const line = runStatusLine(run, {})
    const steps = railSteps(run)
    const activeStep = steps.length > 0 ? steps[activeStepIndex(run.currentStepId, steps)] : undefined
    return (
      <div
        data-slot="running-hint"
        className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground"
      >
        <StatusDot tone={line.attention.tone} shape={line.attention.shape} pulse={line.attention.pulse} />
        <span className="truncate">
          {line.label}
          {activeStep ? ` · ${activeStep.name}` : ''}
        </span>
      </div>
    )
  }

  if (queued) {
    return (
      <div
        data-slot="queued-hint"
        className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
      >
        <StatusDot tone="neutral" shape="ring" />
        Messages you add now are folded into the prompt before the run starts.
      </div>
    )
  }

  if (removedRunnerNotice !== undefined) {
    return <p className="px-1 text-xs text-muted-foreground" role="status">{removedRunnerNotice}</p>
  }

  if (continuable && startsNewConversation) {
    return <p className="px-1 text-xs text-muted-foreground" role="status">Starts a new agent conversation.</p>
  }

  return null
}

/** The list follows the live step, or the effective continuation identity. */
function threadSkillContext(run: ApiRun, continuable: boolean, action: ReturnType<typeof useContinueAction>) {
  if (continuable) return { skillRunner: action.skillRunner, skillAccount: action.skillAccount }
  const step = run.steps.find((entry) => entry.id === run.currentStepId)
  const definition = run.workflowDef?.steps.find((entry) => entry.id === run.currentStepId)
  return {
    skillRunner: step?.backend ?? definition?.runner ?? run.runner,
    skillAccount: step?.profileId ?? definition?.agentProfile ?? run.agentProfile,
  }
}

type ThreadComposerProps = Pick<
  ThreadDecisionZoneProps,
  | 'run'
  | 'thread'
  | 'stopAction'
  | 'finishAction'
  | 'attention'
  | 'needsAnswer'
  | 'continuable'
  | 'continueAction'
  | 'queued'
  | 'sendMessage'
  | 'reply'
  | 'providerBlocked'
  | 'providerReason'
  | 'sessionOpen'
> & {
  canStop: boolean
  hasPendingAsk: boolean
}

function resolveComposerDelivery(props: ThreadComposerProps) {
  const { run, hasPendingAsk, continuable, continueAction, queued, sendMessage, reply, providerBlocked, providerReason, sessionOpen } = props
  const sendViaAskReply = async (text: string, images: Parameters<typeof reply.send>[1]) => {
    // Share the ask card's idle-close recovery. The composer clears its draft
    // only on success, so convert the hook's returned failure to a rejection.
    const error = await reply.send(text, images)
    if (error !== undefined) throw new Error(error)
  }
  if (hasPendingAsk) {
    return {
      onSubmit: sendViaAskReply,
      pendingLabel: reply.mode === 'resume' ? 'Continuing…' : 'Sending…',
      disabled: providerBlocked || reply.blockedBy !== undefined,
      disabledReason: providerBlocked ? providerReason : reply.reason,
      placeholder: 'Reply — / for skills, @ for files…',
    }
  }
  return {
    onSubmit: continuable
      ? (text: string, images: Parameters<typeof reply.send>[1]) => continueAction.continueWith(text, images ?? [])
      : queued
        ? (text: string, images: Parameters<typeof reply.send>[1]) => sendMessage.mutateAsync({ text, images })
        : sendViaAskReply,
    pendingLabel: continuable ? 'Continuing…' : 'Sending…',
    disabled: providerBlocked || (!sessionOpen && !queued && !continuable),
    disabledReason: providerBlocked ? providerReason : 'Session closed — no session to resume.',
    placeholder: threadComposerPlaceholder(run, queued, continuable),
  }
}

function ThreadComposer(props: ThreadComposerProps) {
  const {
    run, thread, canStop, hasPendingAsk, stopAction, finishAction, attention,
    needsAnswer, continuable, continueAction, providerBlocked,
  } = props
  const delivery = resolveComposerDelivery(props)
  const allowEmpty = !hasPendingAsk && continuable && !needsAnswer

  return (
    <Composer
      {...threadSkillContext(run, continuable, continueAction)}
      onStop={canStop ? stopAction.stop : undefined}
      onFinish={
        offersComposerFinish(run)
          ? () => finishAction.mutateAsync().catch(() => undefined)
          : undefined
      }
      finishing={finishAction.isPending}
      stopOnEmpty={!hasPendingAsk && composerStopsOnEmpty(run, attention, needsAnswer)}
      stopping={stopAction.stopping}
      retainDraftUntilSuccess
      compactFeedback
      pendingLabel={delivery.pendingLabel}
      failureHint="Your draft is kept. Check the task status and connection, then retry."
      sessionControls={!hasPendingAsk && continuable ? continueAction.pills : undefined}
      onSubmit={delivery.onSubmit}
      disabled={delivery.disabled}
      disabledReason={delivery.disabledReason}
      footerEnd={
        providerBlocked && !continueAction.providerPending ? (
          <Link
            to="/settings/agent-defaults#providers"
            className="text-xs font-medium text-foreground underline underline-offset-4"
          >
            Configure providers
          </Link>
        ) : undefined
      }
      allowEmptySubmit={allowEmpty}
      emptySubmitVariant={run.status === 'review' ? 'outline' : 'primary'}
      emptySubmitLabel={allowEmpty ? 'Continue' : undefined}
      placeholder={delivery.placeholder}
      autocompleteSkills
      quickReplies
      getMentionCandidates={() => threadFilePaths(thread)}
    />
  )
}

function composerStopsOnEmpty(run: ApiRun, attention: ReturnType<typeof deriveAttention>, needsAnswer: boolean) {
  // oxlint-disable-next-line cez/attention-bucket-compare-outside-owner -- empty submit stops a wait that asks no person
  return run.status === 'queued' || run.status === 'running' || (run.status === 'waiting' && attention.bucket === 'none' && !needsAnswer)
}

function threadComposerPlaceholder(run: ApiRun, queued: boolean, continuable: boolean) {
  return queued ? 'Add to the prompt — sent when the run starts…'
    : continuable ? 'Continue — add a prompt, or send to just reopen the session…'
    : run.status === 'waiting' ? 'Reply — / for skills, @ for files…'
    : 'Message the agent — / for skills, @ for files…'
}
