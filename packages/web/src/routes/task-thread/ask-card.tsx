import { useId, useRef, useState, type ReactNode } from 'react'

import type { ApiRun, UiAskQuestion } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { useUnsentDraft } from '@/lib/version-reload'

import { useAskAnswer, type AskAnswerDelivery } from './ask-answer'
import { AskAnswers } from './ask-answers'
import {
  AskCommentStep,
  AskContextSheet,
  AskDeliveryNotices,
  AskFreeTextBody,
  DesktopStepPills,
  PendingAskHeader,
  ShowOriginLink,
  SingleAskFooterControls,
  SteppedFooterControls,
  questionAnswered,
  type FreeTextReplyRenderProps,
} from './ask-card-parts'
import { Markdown } from './markdown'
import { ConversationMessage } from './thread-items'
import type { AskClosedReason, ThreadAsk } from './thread-state'

export type { FreeTextReplyRenderProps }

/** What a closed question's card says (hearsay-tools/cezarion#1260, hearsay-tools/cezarion#1301, hearsay-tools/cezarion#2410). */
const ASK_CLOSED_LABEL: Record<AskClosedReason, string> = {
  finish: 'Closed when the task finished',
  superseded: 'Closed when the worker went on',
  'parent-stopped': 'Closed when the parent stopped',
  'worker-stopped': 'Closed when the worker stopped',
  undeliverable: 'Closed: not delivered',
}

/** Format one answered question the way the agent reads it back. */
function formatAnswer(question: UiAskQuestion, labels: string[], otherAnswer?: string): string {
  return `${question.header}: ${otherAnswer?.trim() || labels.join(', ')}`
}

/** Format all structured answers plus an optional trailing comment block. */
export function formatAskPayload(
  questions: readonly UiAskQuestion[],
  selections: Readonly<Record<number, string[]>>,
  otherAnswers: Readonly<Record<number, string>>,
  additionalComment = '',
): string {
  const answers = questions
    .map((q, index) => formatAnswer(q, selections[index] ?? [], otherAnswers[index]))
    .join('\n')
  const note = additionalComment.trim()
  return note ? `${answers}\n\nAdditional comments:\n${note}` : answers
}

/**
 * The AskUser card (#473, unified decision surface in hearsay-tools/squawk#4374):
 * renders structured options (stepped `1 of N` for multi-question asks with an optional
 * trailing comment step), embeds free-text reply as a mode inside the same surface with one
 * send path, and opens long context in a non-destructive sheet without losing drafts.
 */
export function AskCard({
  ask,
  run,
  projectId,
  onShowOrigin,
  onAnswered,
  renderFreeTextReply,
  onStop,
  stopping = false,
  onFinish,
  finishing = false,
  mode,
  onModeChange,
  hideReplyBody = false,
  delivery,
  surface = 'transcript',
}: {
  ask: ThreadAsk
  run: ApiRun
  /** Target project id when triaging from outside `/p/:projectId` (e.g. Global Activity). */
  projectId?: string | undefined
  /** Jump to the question's original place in the transcript (hearsay-tools/cezarion#1495). */
  onShowOrigin?: (() => void) | undefined
  /** Called after an answer is delivered cleanly (used by Activity's inline triage drawer). */
  onAnswered?: (() => void) | undefined
  /** Shared composer rendered inside the embedded free-text reply mode. */
  renderFreeTextReply?: ((props: FreeTextReplyRenderProps) => ReactNode) | undefined
  /** Optional Stop action kept reachable while a pending ask waits for a reply. */
  onStop?: (() => void | Promise<unknown>) | undefined
  stopping?: boolean | undefined
  /** Optional Finish action kept reachable in Options mode when the waiting run can close cleanly. */
  onFinish?: (() => void | Promise<unknown>) | undefined
  finishing?: boolean | undefined
  /** Controlled Options / Write a reply mode for hosts keeping a persistent composer mounted. */
  mode?: 'options' | 'reply' | undefined
  onModeChange?: ((next: 'options' | 'reply') => void) | undefined
  /** Omit inner reply body when the host renders its persistent composer directly beneath the header. */
  hideReplyBody?: boolean | undefined
  /** Optional shared delivery hook so option clicks and the reply composer share one in-flight guard. */
  delivery?: AskAnswerDelivery | undefined
  /** `decision-zone` pins the card at the viewport bottom and opens context in a sheet. */
  surface?: 'transcript' | 'decision-zone' | undefined
}) {
  const inlineContext = surface === 'transcript' && ask.context ? <AskContext text={ask.context} /> : null
  if (ask.resolved) {
    return (
      <div className="flex flex-col gap-3">
        {ask.context ? <AskContext text={ask.context} /> : null}
        <ConversationMessage role="user" data-slot="ask-card" data-resolved="true">
          <span className="text-soft-foreground">
            {ask.closed ? ASK_CLOSED_LABEL[ask.closed] : ask.answeredBy === 'parent' ? 'Answered by parent' : 'Answered'}
          </span>
          <AskAnswers ask={ask} />
        </ConversationMessage>
      </div>
    )
  }
  const showOrigin = ask.placement === 'pinned' && onShowOrigin ? onShowOrigin : undefined
  if (ask.routedToParent) {
    return (
      <div className="flex flex-col gap-3">
        {inlineContext}
        <RoutedAsk ask={ask} runId={run.id} surface={surface} onShowOrigin={showOrigin} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {inlineContext}
      <PendingAsk
        ask={ask}
        run={run}
        projectId={projectId}
        surface={surface}
        onShowOrigin={showOrigin}
        onAnswered={onAnswered}
        renderFreeTextReply={renderFreeTextReply}
        onStop={onStop}
        stopping={stopping}
        onFinish={onFinish}
        finishing={finishing}
        controlledMode={mode}
        onModeChange={onModeChange}
        hideReplyBody={hideReplyBody}
        delivery={delivery}
      />
    </div>
  )
}

/**
 * The draft, findings or evidence the agent sent with its question (hearsay-tools/cezarion#1458),
 * as an ordinary agent response. The thread owns scrolling, even for long context.
 */
export function AskContext({ text }: { text: string }) {
  return (
    <ConversationMessage role="agent">
      <div
        data-slot="ask-context"
        role="region"
        aria-label="Context"
        className="break-words text-sm text-foreground"
      >
        <Markdown breaks>{text}</Markdown>
      </div>
    </ConversationMessage>
  )
}

/** A worker's question sent to its parent task (#505): read-only here, answered there. */
function RoutedAsk({
  ask,
  runId,
  surface,
  onShowOrigin,
}: {
  ask: ThreadAsk
  runId: string
  surface: 'transcript' | 'decision-zone'
  onShowOrigin: (() => void) | undefined
}) {
  const [contextOpen, setContextOpen] = useState(false)
  const contextButtonRef = useRef<HTMLButtonElement>(null)
  const hasSheetContext = surface === 'decision-zone' && Boolean(ask.context)
  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-ask-id={ask.id}
      data-pinned={ask.placement === 'pinned' ? 'true' : undefined}
      data-routed="parent"
      className="rounded-xl border border-card-edge bg-card shadow-card px-3 py-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-link-foreground">The agent is asking its parent</span>
        {hasSheetContext ? (
          <Button
            ref={contextButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            data-slot="ask-show-context"
            className="ms-auto min-h-11 min-w-11 px-2 text-xs font-medium text-link-foreground underline underline-offset-4 md:min-h-8 md:min-w-0"
            onClick={() => setContextOpen(true)}
          >
            Show context
          </Button>
        ) : null}
      </div>
      <div data-slot="ask-body" className="flex flex-col gap-3">
        {ask.questions.map((question, index) => (
          <div key={question.id ?? index} role="group" aria-label={question.question}>
            <div className="mb-0.5 flex items-center gap-2">
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            </div>
            <p className="mb-1.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
            {question.options ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-muted-foreground">
                {question.options.map((option) => (
                  <li key={option.label} className="break-words">
                    <span className="text-foreground">{option.label}</span>
                    {option.description ? <span>: {option.description}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-slot="ask-open-routed" className="text-[13px] text-muted-foreground">
                Open question: answered in words, with no options.
              </p>
            )}
          </div>
        ))}
      </div>
      <div data-slot="ask-footer" className="mt-2.5 flex flex-wrap items-center gap-2">
        <p data-slot="ask-routed-hint" className="text-xs text-muted-foreground">
          Routed to parent: answer it in the{' '}
          {ask.parentRunId ? (
            <Link to={`/tasks/${ask.parentRunId}`} className="font-medium text-foreground underline underline-offset-4">
              parent task
            </Link>
          ) : (
            'parent task'
          )}
          .
        </p>
        {!hasSheetContext && onShowOrigin ? <ShowOriginLink onShowOrigin={onShowOrigin} className="ms-auto" /> : null}
      </div>
      {hasSheetContext && ask.context ? (
        <AskContextSheet
          open={contextOpen}
          onOpenChange={setContextOpen}
          runId={runId}
          context={ask.context}
          onShowOrigin={onShowOrigin}
          returnFocusRef={contextButtonRef}
        />
      ) : null}
    </div>
  )
}

function usePendingAskState(
  ask: ThreadAsk,
  delivery: AskAnswerDelivery,
  controlledMode?: 'options' | 'reply',
  onModeChange?: (next: 'options' | 'reply') => void,
  onAnswered?: () => void,
) {
  const blocked = delivery.blockedBy !== undefined
  const questions = ask.questions
  const stepped = questions.length > 1
  const commentStepIndex = questions.length
  const [uncontrolledMode, setUncontrolledMode] = useState<'options' | 'reply'>('options')
  const mode = controlledMode ?? uncontrolledMode
  const setMode = (next: 'options' | 'reply') => {
    setUncontrolledMode(next)
    onModeChange?.(next)
  }
  const [stepIndex, setStepIndex] = useState(0)
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<number, string>>({})
  const [additionalComment, setAdditionalComment] = useState('')
  const [singleCommentOpen, setSingleCommentOpen] = useState(false)
  const [freeTextDraft, setFreeTextDraft] = useState('')
  const [contextOpen, setContextOpen] = useState(false)

  const onCommentStep = stepped && stepIndex === commentStepIndex
  const oneTap =
    questions.length === 1 &&
    questions[0]?.options !== undefined &&
    questions[0]?.multiSelect !== true &&
    !singleCommentOpen &&
    additionalComment.trim() === ''

  const hasDraft =
    Object.values(selections).some((labels) => labels.length > 0) ||
    Object.values(otherAnswers).some((text) => text.trim() !== '') ||
    additionalComment.trim() !== '' ||
    freeTextDraft.trim() !== ''
  useUnsentDraft(hasDraft)

  const setQuestion = (index: number, labels: string[]) =>
    setSelections((prev) => ({ ...prev, [index]: labels }))

  const clearOtherAnswer = (index: number) =>
    setOtherAnswers((prev) => {
      if (prev[index] === undefined) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })

  const selectOther = (index: number) => {
    setQuestion(index, [])
    setOtherAnswers((prev) => ({ ...prev, [index]: prev[index] ?? '' }))
  }

  const hasOtherAnswer = questions.some((question, index) => !question.options || otherAnswers[index] !== undefined)
  const answeredCount = questions.filter((_, index) => questionAnswered(index, selections, otherAnswers)).length
  const allAnswered = answeredCount === questions.length
  const deliver = async (text: string) => {
    const error = await delivery.send(text)
    if (error === undefined) onAnswered?.()
    return error
  }
  const sendAll = () =>
    void deliver(formatAskPayload(questions, selections, otherAnswers, additionalComment))
  const sendFreeText = () => {
    const trimmed = freeTextDraft.trim()
    if (!trimmed) return
    void deliver(trimmed).then((err) => {
      if (err === undefined) setFreeTextDraft('')
    })
  }

  return {
    delivery, blocked, questions, stepped, commentStepIndex,
    mode, setMode, stepIndex, setStepIndex, selections, otherAnswers, setOtherAnswers,
    additionalComment, setAdditionalComment, singleCommentOpen, setSingleCommentOpen,
    freeTextDraft, setFreeTextDraft, contextOpen, setContextOpen,
    onCommentStep, oneTap, setQuestion, clearOtherAnswer, selectOther,
    hasOtherAnswer, answeredCount, allAnswered, deliver, sendAll, sendFreeText,
  }
}

function PendingAskBody({
  state,
  renderFreeTextReply,
}: {
  state: ReturnType<typeof usePendingAskState>
  renderFreeTextReply: ((props: FreeTextReplyRenderProps) => ReactNode) | undefined
}) {
  const singleCommentId = useId()
  const disabled = state.delivery.isPending || state.blocked
  if (state.mode === 'reply') {
    return (
      <AskFreeTextBody
        value={state.freeTextDraft}
        onValueChange={state.setFreeTextDraft}
        disabled={disabled}
        renderFreeTextReply={renderFreeTextReply}
      />
    )
  }
  if (state.onCommentStep) {
    return (
      <AskCommentStep
        questions={state.questions}
        selections={state.selections}
        otherAnswers={state.otherAnswers}
        comment={state.additionalComment}
        disabled={disabled}
        onCommentChange={state.setAdditionalComment}
        onJumpToQuestion={state.setStepIndex}
      />
    )
  }
  const activeIndex = state.stepped ? Math.min(state.stepIndex, state.questions.length - 1) : 0
  const activeQuestion = state.questions[activeIndex]
  if (!activeQuestion) return null
  return (
    <>
      <AskQuestionBlock
        key={activeQuestion.id ?? activeIndex}
        question={activeQuestion}
        disabled={disabled}
        selected={state.selections[activeIndex] ?? []}
        isOther={state.otherAnswers[activeIndex] !== undefined}
        otherAnswer={state.otherAnswers[activeIndex] ?? ''}
        onSelect={(labels) => {
          if (state.blocked) return
          state.clearOtherAnswer(activeIndex)
          if (state.oneTap) void state.deliver(formatAnswer(activeQuestion, labels))
          else state.setQuestion(activeIndex, labels)
        }}
        onOtherToggle={() => {
          if (state.blocked) return
          if (state.otherAnswers[activeIndex] === undefined) state.selectOther(activeIndex)
          else state.clearOtherAnswer(activeIndex)
        }}
        onOtherChange={(answer) =>
          state.setOtherAnswers((prev) => ({ ...prev, [activeIndex]: answer }))
        }
      />
      {!state.stepped && state.singleCommentOpen ? (
        <div className="pt-1">
          <label htmlFor={singleCommentId} className="mb-1 block text-xs font-medium text-foreground">
            Additional comments (optional)
          </label>
          <Textarea
            id={singleCommentId}
            data-slot="ask-additional-comment"
            rows={2}
            value={state.additionalComment}
            disabled={disabled}
            placeholder="Optional extra notes for the agent…"
            onChange={(event) => state.setAdditionalComment(event.target.value)}
            className="bg-card text-base md:text-[13px]"
          />
        </div>
      ) : null}
    </>
  )
}

interface PendingAskProps {
  ask: ThreadAsk
  run: ApiRun
  projectId: string | undefined
  surface: 'transcript' | 'decision-zone'
  onShowOrigin: (() => void) | undefined
  onAnswered: (() => void) | undefined
  renderFreeTextReply: ((props: FreeTextReplyRenderProps) => ReactNode) | undefined
  onStop: (() => void | Promise<unknown>) | undefined
  stopping: boolean
  onFinish: (() => void | Promise<unknown>) | undefined
  finishing: boolean
  controlledMode: 'options' | 'reply' | undefined
  onModeChange: ((next: 'options' | 'reply') => void) | undefined
  hideReplyBody: boolean
  delivery: AskAnswerDelivery | undefined
}

function PendingAskSecondaryActions({
  onFinish,
  finishing,
  onStop,
  stopping,
  onActionError,
}: {
  onFinish: (() => void | Promise<unknown>) | undefined
  finishing: boolean
  onStop: (() => void | Promise<unknown>) | undefined
  stopping: boolean
  onActionError: (message: string | undefined) => void
}) {
  if (!onFinish && !onStop) return null
  const runAction = (action: () => void | Promise<unknown>) => {
    onActionError(undefined)
    void Promise.resolve(action()).catch((err: unknown) => {
      onActionError(err instanceof Error ? err.message : String(err))
    })
  }
  return (
    <>
      {onFinish ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="ask-finish"
          disabled={finishing || stopping}
          title="Close the session and mark this task done"
          className="min-h-11 min-w-11 px-3 md:min-h-8 md:min-w-0"
          onClick={() => runAction(onFinish)}
        >
          {finishing ? 'Finishing…' : 'Finish'}
        </Button>
      ) : null}
      {onStop ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={stopping || finishing}
          className="min-h-11 min-w-11 px-3 md:min-h-8 md:min-w-0"
          onClick={() => runAction(onStop)}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      ) : null}
    </>
  )
}

/** The unanswered card: stepped multi-question options, optional comment step, and unified free-text mode. */
function PendingAsk(props: PendingAskProps) {
  if (props.delivery !== undefined) {
    return <PendingAskContent {...props} delivery={props.delivery} />
  }
  return <PendingAskOwnDelivery {...props} />
}

function PendingAskOwnDelivery(props: Omit<PendingAskProps, 'delivery'>) {
  const delivery = useAskAnswer(props.run, props.projectId)
  return <PendingAskContent {...props} delivery={delivery} />
}

function PendingAskContent({
  ask,
  run,
  surface,
  onShowOrigin,
  onAnswered,
  renderFreeTextReply,
  onStop,
  stopping,
  onFinish,
  finishing,
  controlledMode,
  onModeChange,
  hideReplyBody,
  delivery,
}: Omit<PendingAskProps, 'delivery'> & { delivery: AskAnswerDelivery }) {
  const state = usePendingAskState(ask, delivery, controlledMode, onModeChange, onAnswered)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const contextButtonRef = useRef<HTMLButtonElement>(null)
  const resuming = state.delivery.mode === 'resume'
  const showModeSwitch = surface === 'decision-zone' || renderFreeTextReply !== undefined
  const hasSheetContext = surface === 'decision-zone' && Boolean(ask.context)
  const hasComment = state.additionalComment.trim() !== ''
  const replyDockedOutside = state.mode === 'reply' && hideReplyBody
  const stopControl = (
    <PendingAskSecondaryActions
      onFinish={onFinish}
      finishing={finishing}
      onStop={onStop}
      stopping={stopping}
      onActionError={setActionError}
    />
  )

  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-ask-id={ask.id}
      data-ask-mode={state.mode}
      data-pinned={ask.placement === 'pinned' ? 'true' : undefined}
      data-delivery={state.delivery.mode}
      className={cn(
        'rounded-xl border border-accent-strong/30 bg-accent-strong/[0.04] [html:not(.light)_&]:bg-card',
        replyDockedOutside && 'rounded-b-none border-b-0',
      )}
    >
      <PendingAskHeader
        stepped={state.stepped}
        mode={state.mode}
        onModeChange={state.setMode}
        showModeSwitch={showModeSwitch}
        stepLabel={state.onCommentStep ? 'Comment (optional)' : `${state.stepIndex + 1} of ${state.questions.length}`}
        hasSheetContext={hasSheetContext}
        showContextButtonRef={contextButtonRef}
        onOpenContext={() => state.setContextOpen(true)}
        onShowOrigin={!hasSheetContext ? onShowOrigin : undefined}
      />

      {state.stepped && state.mode === 'options' ? (
        <DesktopStepPills
          questions={state.questions}
          stepIndex={state.stepIndex}
          selections={state.selections}
          otherAnswers={state.otherAnswers}
          hasComment={hasComment}
          onSelectStep={state.setStepIndex}
        />
      ) : null}

      {!replyDockedOutside ? (
        <>
          <div data-slot="ask-body" className="flex flex-col gap-2.5 px-3 py-2.5">
            <PendingAskBody state={state} renderFreeTextReply={renderFreeTextReply} />
          </div>

          <div
            data-slot="ask-footer"
            className="flex shrink-0 flex-col gap-2 border-t border-border/70 px-3 py-2"
          >
            <PendingAskFooter
              state={state}
              hasComment={hasComment}
              resuming={resuming}
              hasCustomReply={renderFreeTextReply !== undefined}
              stopControl={stopControl}
            />
            <AskDeliveryNotices
              blockedBy={state.delivery.blockedBy}
              reason={state.delivery.reason}
              error={state.delivery.error ?? actionError}
            />
          </div>
        </>
      ) : null}

      {hasSheetContext && ask.context ? (
        <AskContextSheet
          open={state.contextOpen}
          onOpenChange={state.setContextOpen}
          runId={run.id}
          context={ask.context}
          onShowOrigin={onShowOrigin}
          returnFocusRef={contextButtonRef}
        />
      ) : null}
    </div>
  )
}

function PendingAskFooter({
  state,
  hasComment,
  resuming,
  hasCustomReply,
  stopControl,
}: {
  state: ReturnType<typeof usePendingAskState>
  hasComment: boolean
  resuming: boolean
  hasCustomReply: boolean
  stopControl: ReactNode
}) {
  if (state.mode === 'reply') {
    if (hasCustomReply) return null
    return (
      <div className="flex items-center justify-end gap-2">
        {stopControl}
        <Button
          type="button"
          size="sm"
          className="min-h-11 min-w-11 px-3.5 md:min-h-8 md:min-w-0"
          disabled={state.delivery.isPending || state.blocked || state.freeTextDraft.trim() === ''}
          onClick={state.sendFreeText}
        >
          Send reply
        </Button>
      </div>
    )
  }
  if (state.stepped) {
    return (
      <SteppedFooterControls
        stepIndex={state.stepIndex}
        questionCount={state.questions.length}
        answeredCount={state.answeredCount}
        allAnswered={state.allAnswered}
        hasComment={hasComment}
        resuming={resuming}
        disabled={state.delivery.isPending || state.blocked}
        onBack={() => state.setStepIndex((prev) => Math.max(0, prev - 1))}
        onNext={() => state.setStepIndex((prev) => Math.min(state.commentStepIndex, prev + 1))}
        onOpenComment={() => state.setStepIndex(state.commentStepIndex)}
        onSend={state.sendAll}
        questions={state.questions}
        selections={state.selections}
        otherAnswers={state.otherAnswers}
        stopControl={stopControl}
      />
    )
  }
  return (
    <SingleAskFooterControls
      oneTap={state.oneTap}
      hasOtherAnswer={state.hasOtherAnswer}
      allowComment={state.questions[0]?.allowFreeText !== false}
      commentOpen={state.singleCommentOpen}
      hasComment={hasComment}
      resuming={resuming}
      disabled={state.delivery.isPending || state.blocked || !state.allAnswered}
      onToggleComment={() => state.setSingleCommentOpen((open) => !open)}
      onSend={state.sendAll}
      stopControl={stopControl}
    />
  )
}

function AskQuestionBlock({
  question,
  disabled,
  selected,
  isOther,
  otherAnswer,
  onSelect,
  onOtherToggle,
  onOtherChange,
}: {
  question: UiAskQuestion
  disabled: boolean
  selected: string[]
  isOther: boolean
  otherAnswer: string
  onSelect: (labels: string[]) => void
  onOtherToggle: () => void
  onOtherChange: (answer: string) => void
}) {
  const answerId = useId()
  const options = question.options
  const multiSelect = options !== undefined && question.multiSelect === true

  const pick = (label: string) => {
    if (!multiSelect) {
      onSelect([label])
      return
    }
    onSelect(
      selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label],
    )
  }

  return (
    <div data-slot="ask-question" role="group" aria-label={question.question}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="shrink-0 rounded-md bg-accent-strong px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-strong-foreground">
          {question.header}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">{question.question}</p>
        {multiSelect ? (
          <span className="ms-auto text-xs text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      {options ? (
        <>
          <div data-slot="ask-options" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-2">
            {options.map((option) => {
              const isSelected = selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  onClick={() => pick(option.label)}
                  className={cn(
                    'flex min-h-11 w-full flex-col items-start justify-start content-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    'pointer-hover:border-accent-strong/50 pointer-hover:bg-accent-strong/[0.06] [html:not(.light)_&]:pointer-hover:bg-card disabled:pointer-events-none disabled:opacity-50',
                    isSelected ? 'border-accent-strong/60 bg-accent-strong/[0.06] [html:not(.light)_&]:bg-card' : 'border-border bg-card',
                  )}
                >
                  <span className="flex min-w-0 items-start gap-2 text-[13px] font-semibold text-foreground">
                    {multiSelect ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border text-[12px]',
                          isSelected
                            ? 'border-accent-strong bg-accent-strong text-accent-strong-foreground'
                            : 'border-soft-foreground',
                        )}
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                    ) : null}
                    <span className="min-w-0 break-words">{option.label}</span>
                  </span>
                  {option.description ? (
                    <span className="min-w-0 break-words text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              )
            })}
            {question.allowFreeText !== false ? (
              <Button
                type="button"
                variant="outline"
                aria-pressed={isOther}
                aria-expanded={isOther}
                aria-controls={isOther ? answerId : undefined}
                disabled={disabled}
                onClick={onOtherToggle}
                className={cn(
                  'h-auto min-h-11 w-full justify-start px-2.5 py-1.5 text-left',
                  options.length % 2 === 0 && 'sm:col-span-2',
                  isOther && 'border-accent-strong/60 bg-accent-strong/[0.06] [html:not(.light)_&]:bg-card',
                )}
              >
                Other
              </Button>
            ) : null}
          </div>
          {question.allowFreeText !== false && isOther ? (
            <div className="mt-2">
              <label htmlFor={answerId} className="mb-1.5 block text-xs font-medium text-foreground">
                Your answer
              </label>
              <Textarea
                id={answerId}
                rows={2}
                value={otherAnswer}
                disabled={disabled}
                onChange={(event) => onOtherChange(event.target.value)}
                className="bg-card text-base md:text-[13px]"
              />
            </div>
          ) : null}
        </>
      ) : (
        <div>
          <label htmlFor={answerId} className="mb-1.5 block text-xs font-medium text-foreground">
            Your answer
          </label>
          <Textarea
            id={answerId}
            rows={2}
            value={otherAnswer}
            disabled={disabled}
            onChange={(event) => onOtherChange(event.target.value)}
            className="bg-card text-base md:text-[13px]"
          />
        </div>
      )}
    </div>
  )
}
